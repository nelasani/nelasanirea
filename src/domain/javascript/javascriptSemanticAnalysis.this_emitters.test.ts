import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const emitters = (source: string) => {
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.coverage.status).toBe("complete");
  const groups = new Map<string, string[]>();
  for (const { emitterKey, method, resolution } of ir.eventOperations)
    groups.set(emitterKey, [
      ...(groups.get(emitterKey) ?? []),
      `${method}:${resolution}`,
    ]);
  return [...groups.values()];
};

it("separates unrelated this receivers and preserves the stable binding control", () => {
  expect(
    emitters(`
    import { EventEmitter } from 'node:events';
    class Producer extends EventEmitter { run() { this.on('ready', () => {}); } }
    class Unrelated extends EventEmitter { run() { this.emit('ready'); } }
    const stable = new EventEmitter();
    stable.on('ready', () => {}); stable.emit('ready');
  `),
  ).toEqual([
    ["on:partial"],
    ["emit:partial"],
    ["on:complete", "emit:complete"],
  ]);
});

it("shares candidate instance receivers across constructors, fields, accessors and arrows", () => {
  expect(
    emitters(`class E {
    constructor() { this.on('ready', handler); }
    field = () => this.emit('ready');
    get value() { return this.emit('ready'); }
    #remove() { this.off('ready', handler); }
    run() { (() => this.emit('ready'))(); }
  }`),
  ).toEqual([
    [
      "on:partial",
      "emit:partial",
      "emit:partial",
      "off:partial",
      "emit:partial",
    ],
  ]);
});

it("separates static and instance receivers while sharing static blocks and fields", () => {
  expect(
    emitters(`class E {
    static { this.on('ready', handler); }
    static field = this.emit('ready');
    static run() { this.off('ready', handler); }
    run() { this.emit('ready'); }
  }`),
  ).toEqual([["on:partial", "emit:partial", "off:partial"], ["emit:partial"]]);
});

it("gives ordinary functions distinct receivers and arrows their enclosing receiver", () => {
  expect(
    emitters(`
    this.on('ready', handler); (() => this.emit('ready'))();
    function outer() {
      this.on('ready', handler); (() => this.emit('ready'))();
      function inner() { this.emit('ready'); }
      const regular = function () { this.emit('ready'); };
    }
    function other() { this.emit('ready'); }
  `),
  ).toEqual([
    ["on:partial", "emit:partial"],
    ["on:partial", "emit:partial"],
    ["emit:partial"],
    ["emit:partial"],
    ["emit:partial"],
  ]);
});

it("keeps object methods together but object arrow properties in the enclosing scope", () => {
  expect(
    emitters(`
    this.on('ready', handler);
    const object = {
      onReady() { this.on('ready', handler); },
      dispatch: function () { this.emit('ready'); },
      arrow: () => this.emit('ready'),
    };
    const other = { run() { this.emit('ready'); } };
  `),
  ).toEqual([
    ["on:partial", "emit:partial"],
    ["on:partial", "emit:partial"],
    ["emit:partial"],
  ]);
});

it("evaluates decorators, computed keys and heritage in the enclosing receiver", () => {
  expect(
    emitters(`function install() {
    this.on('ready', handler);
    @decorate(this.emit('ready'))
    class E extends (this.emit('ready'), Base) {
      @decorate(this.emit('ready')) run() { this.emit('ready'); }
      @decorate(this.emit('ready')) field = this.emit('ready');
      [this.emit('ready')]() { this.off('ready', handler); }
      [this.emit('ready')] = this.emit('ready');
    }
    const obj = { [this.emit('ready')]() { this.emit('ready'); } };
  }`),
  ).toEqual([
    [
      "on:partial",
      "emit:partial",
      "emit:partial",
      "emit:partial",
      "emit:partial",
      "emit:partial",
      "emit:partial",
      "emit:partial",
    ],
    ["emit:partial", "emit:partial", "off:partial", "emit:partial"],
    ["emit:partial"],
  ]);
});

it("retains candidate event links across local inheritance and keeps other classes separate", () => {
  expect(
    emitters(`
    class Base { run() { this.on('ready', handler); } }
    class Child extends Base { run() { this.emit('ready'); } }
    class Other { run() { this.emit('ready'); } }
  `),
  ).toEqual([["on:partial", "emit:partial"], ["emit:partial"]]);
});

it.each([
  "flag ? Base : Other",
  "Base || Other",
  "flag ? Base : external",
  "(0, Base)",
])("retains possible base event links for %s", (base) => {
  const groups = emitters(`
      class Base { run() { this.on('ready', handler); } }
      class Other { run() { this.off('ready', handler); } }
      class Child extends (${base}) { run() { this.emit('ready'); } }
    `);
  expect(groups[0]).toContain("on:partial");
  expect(groups[0]).toContain("emit:partial");
  expect(groups.flat()).toHaveLength(3);
  if (!base.includes("Other")) expect(groups).toHaveLength(2);
  else expect(groups).toHaveLength(1);
});

it("keeps unresolved external bases separate and dynamic event names unresolved", () => {
  expect(
    emitters(`
    class A extends external { run() { this.on(name, handler); } }
    class B extends external { run() { this.emit('ready'); } }
  `),
  ).toEqual([["on:unresolved"], ["emit:partial"]]);
});

it("terminates cyclic class candidates without treating them as complete", () => {
  expect(
    emitters(`
    class A extends B { run() { this.on('ready', handler); } }
    class B extends A { run() { this.emit('ready'); } }
  `),
  ).toEqual([["on:partial", "emit:partial"]]);
});

it.each(["run() {}", "static run() {}", "#run() {}", "field = 0"])(
  "assigns %s decorators to class definition evaluation, outside method callables",
  (member) => {
    const ir = analyzeJavaScriptSemantics(`function install() {
    this.on('ready', handler);
    class E { @decorate(this.emit('ready')) ${member} }
  }`);
    expect(ir.eventOperations).toHaveLength(2);
    expect(ir.eventOperations[1]?.ownerCallableId).toBe(
      ir.callables.find(({ name, kind }) => name === "E" && kind === "class")
        ?.callableId,
    );
    expect(ir.eventOperations[1]?.emitterKey).toBe(
      ir.eventOperations[0]?.emitterKey,
    );
  },
);

it("keeps receivers partial when the same function is invoked with different this values", () => {
  expect(
    emitters(`
    function run() { this.on('ready', handler); this.emit('ready'); }
    run.call(first); run.apply(second); run.bind(third)();
  `),
  ).toEqual([["on:partial", "emit:partial"]]);
});

it("retains a candidate link across a long class chain", () => {
  const classes = ["class C0 { run() { this.on('ready', handler); } }"];
  for (let index = 1; index <= 500; index++)
    classes.push(`class C${index} extends C${index - 1} {}`);
  classes.push("class Child extends C500 { run() { this.emit('ready'); } }");
  expect(emitters(classes.join("\n"))).toEqual([
    ["on:partial", "emit:partial"],
  ]);
});

it.each(["run", "constructor"])(
  "evaluates %s parameter decorators outside the member receiver and callable",
  (method) => {
    const ir = analyzeJavaScriptSemantics(`function install() {
    this.on('ready', handler);
    class E {
      ${method}(@decorate((() => this.emit('ready'))()) parameter) {
        this.off('ready', handler);
      }
    }
  }`);
    expect(ir.coverage.status).toBe("complete");
    const [register, dispatch, remove] = ir.eventOperations;
    expect(ir.eventOperations).toHaveLength(3);
    expect(dispatch?.emitterKey).toBe(register?.emitterKey);
    expect(remove?.emitterKey).not.toBe(register?.emitterKey);
    // A nested arrow is its own callable but keeps the decorator's receiver.
    expect(
      ir.callables.find(
        ({ callableId }) => callableId === dispatch?.ownerCallableId,
      )?.kind,
    ).toBe("function");
    const direct = analyzeJavaScriptSemantics(`function install() {
    class E { ${method}(@decorate(this.emit('ready')) parameter = this.emit('default')) {} }
  }`);
    const decorator = direct.eventOperations.find(
      ({ eventName }) => eventName === "ready",
    );
    const defaultValue = direct.eventOperations.find(
      ({ eventName }) => eventName === "default",
    );
    expect(decorator?.ownerCallableId).toBe(
      direct.callables.find(({ name }) => name === "E")?.callableId,
    );
    expect(direct.eventOperations).toHaveLength(2);
    expect(decorator?.emitterKey).not.toBe(defaultValue?.emitterKey);
  },
);
