import * as t from "@babel/types";

import { semanticClassCandidates } from "./javascriptSemanticObjectReferences.js";
import { semanticCallableIdForNode } from "./javascriptSemanticProjection.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

type ClassNode = t.ClassDeclaration | t.ClassExpression;
interface Receiver {
  readonly owner: t.Node;
  readonly side?: "instance" | "static";
}

/**
 * Source receiver scopes, not proofs of runtime object equality. Repeated
 * construction, invocation and rebinding remain candidates in the event IR.
 * Reuse the binding owner's parsed parents, callable IDs and class candidates.
 */
export const createSemanticThisReceiverKey = (
  state: JavaScriptSemanticAnalysisState,
): ((node: t.ThisExpression) => string) => {
  const receivers = new WeakMap<t.Node, Receiver>();
  let classComponents: ReturnType<typeof candidateClassComponents> | undefined;
  return (node) => {
    const pending: t.Node[] = [];
    let current: t.Node | undefined = node;
    let receiver: Receiver = { owner: state.program };
    while (current !== undefined) {
      const cached = receivers.get(current);
      if (cached !== undefined) {
        receiver = cached;
        break;
      }
      pending.push(current);
      const parent = state.parentsByNode.get(current);
      if (t.isDecorator(current)) {
        // Parameter decorators may sit under an Identifier/AssignmentPattern.
        // Jump to class definition evaluation without caching those parameter
        // nodes: defaults in the same parameter still use the method receiver.
        current = parent;
        while (current !== undefined && !t.isClass(current))
          current = state.parentsByNode.get(current);
        continue;
      }
      const boundary = receiverBoundary(parent, current, state);
      if (boundary !== undefined) {
        receiver = boundary;
        break;
      }
      current = parent;
    }
    // Each ancestor path is interpreted once, even with many event operations
    // in a deeply nested body. Child evaluation positions define boundaries.
    for (const visited of pending) receivers.set(visited, receiver);
    const { owner, side } = receiver;
    if (t.isClass(owner)) {
      classComponents ??= candidateClassComponents(state);
      return `this:${semanticCallableIdForNode(classComponents(owner))}:${side}`;
    }
    if (t.isObjectExpression(owner))
      return `this:object:${String(owner.start ?? -1)}:${String(owner.end ?? -1)}`;
    return `this:${semanticCallableIdForNode(owner) ?? state.scopeByNode.get(owner)?.scopeId ?? "program"}`;
  };
};

const receiverBoundary = (
  parent: t.Node | undefined,
  child: t.Node,
  state: JavaScriptSemanticAnalysisState,
): Receiver | undefined => {
  if (parent === undefined) return undefined;
  if (t.isFunction(parent) && !t.isArrowFunctionExpression(parent)) {
    if (
      (t.isClassMethod(parent) ||
        t.isClassPrivateMethod(parent) ||
        t.isObjectMethod(parent)) &&
      parent.key === child
    )
      return undefined;
    if (t.isClassMethod(parent) || t.isClassPrivateMethod(parent))
      return classReceiver(parent, state);
    const container = state.parentsByNode.get(parent);
    const object =
      t.isObjectProperty(container) && container.value === parent
        ? state.parentsByNode.get(container)
        : container;
    return { owner: t.isObjectExpression(object) ? object : parent };
  }
  if (
    t.isStaticBlock(parent) ||
    ((t.isClassProperty(parent) ||
      t.isClassPrivateProperty(parent) ||
      t.isClassAccessorProperty(parent)) &&
      parent.value === child)
  )
    return classReceiver(parent, state);
  return undefined;
};

const classReceiver = (
  member:
    | t.ClassMethod
    | t.ClassPrivateMethod
    | t.ClassProperty
    | t.ClassPrivateProperty
    | t.ClassAccessorProperty
    | t.StaticBlock,
  state: JavaScriptSemanticAnalysisState,
): Receiver | undefined => {
  const body = state.parentsByNode.get(member);
  const owner = body === undefined ? undefined : state.parentsByNode.get(body);
  return t.isClass(owner)
    ? {
        owner,
        side: t.isStaticBlock(member) || member.static ? "static" : "instance",
      }
    : undefined;
};

/**
 * A connected candidate family preserves possible inherited event links,
 * including conditional bases. Every edge stays partial; shared ancestry
 * cannot prove two instances are identical. External bases do not join classes.
 * Union by size and path compression avoid repeated full ancestor searches.
 */
const candidateClassComponents = (state: JavaScriptSemanticAnalysisState) => {
  const parents = new Map<ClassNode, ClassNode>();
  const sizes = new Map<ClassNode, number>();
  const representatives = new Map<ClassNode, ClassNode>();
  const root = (node: ClassNode): ClassNode => {
    const path: ClassNode[] = [];
    let current = node;
    let parent = parents.get(current);
    while (parent !== undefined && parent !== current) {
      path.push(current);
      current = parent;
      parent = parents.get(current);
    }
    for (const visited of path) parents.set(visited, current);
    return current;
  };
  for (const node of state.callableNodesById.values()) {
    if (!t.isClass(node) || node.superClass == null) continue;
    for (const base of semanticClassCandidates(node.superClass, state)) {
      let left = root(node);
      let right = root(base);
      if (left === right) continue;
      if ((sizes.get(left) ?? 1) < (sizes.get(right) ?? 1))
        [left, right] = [right, left];
      const first = representatives.get(left) ?? left;
      const second = representatives.get(right) ?? right;
      parents.set(right, left);
      sizes.set(left, (sizes.get(left) ?? 1) + (sizes.get(right) ?? 1));
      representatives.set(
        left,
        (first.start ?? -1) <= (second.start ?? -1) ? first : second,
      );
    }
  }
  return (node: ClassNode): ClassNode => {
    const component = root(node);
    return representatives.get(component) ?? component;
  };
};
