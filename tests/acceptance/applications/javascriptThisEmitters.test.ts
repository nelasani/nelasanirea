import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "scopes this event identities and retains uncertain inheritance through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-this-emitters-");
    await writeFile(
      join(root, "main.mjs"),
      `
    import { EventEmitter } from 'node:events';
    class Producer extends EventEmitter { run() { this.on('ready', () => {}); } }
    class Unrelated extends EventEmitter { run() { this.emit('ready'); } }
    const stable = new EventEmitter();
    stable.on('ready', () => {}); stable.emit('ready');
    class Base { run() { this.on('inherited', () => {}); } }
    class Other { run() { this.on('inherited', () => {}); } }
    class Child extends (flag ? Base : Other) { run() { this.emit('inherited'); } }
  `,
    );
    const response = await cli.run({
      arguments: ["analyze-javascript-application", root, "--format", "json"],
      timeoutMs: 60_000,
    });
    expect(response.exitCode).toBe(0);
    const contract = toolContract("analyze_javascript_application");
    const cliEvidence = contract.outputSchema.parse(response.json);
    const cliGraph = javascriptApplicationAnalysisResultSchema.parse(
      cliEvidence.normalized_result,
    ).semantic_graph;
    const client = new Client({ name: "this-emitters-e2e", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: root, format: "directory" },
      });
      expect(result.isError).not.toBe(true);
      const evidence = contract.outputSchema.parse(result.structuredContent);
      const graph = javascriptApplicationAnalysisResultSchema.parse(
        evidence.normalized_result,
      ).semantic_graph;
      expect(graph).toEqual(cliGraph);
      const ready = graph.nodes.filter(
        (n) => n.kind === "event" && n.properties.event_name === "ready",
      );
      expect(ready).toHaveLength(3);
      const stable = ready.find((n) =>
        String(n.properties.emitter_key).startsWith("binding:"),
      );
      expect(stable).toBeDefined();
      const eventRelations = graph.relations.filter((r) =>
        ["registers-listener", "dispatches-candidate"].includes(r.relation),
      );
      expect(
        eventRelations
          .filter(
            (r) =>
              r.source_node_id === stable?.node_id ||
              r.target_node_id === stable?.node_id,
          )
          .map((r) => r.resolution),
      ).toEqual(["resolved", "resolved"]);
      for (const event of ready.filter((n) => n !== stable)) {
        expect(
          eventRelations.filter(
            (r) =>
              r.source_node_id === event.node_id ||
              r.target_node_id === event.node_id,
          ),
        ).toHaveLength(1);
        expect(
          graph.unknowns.some(
            (u) => u.family === "event" && u.node_id === event.node_id,
          ),
        ).toBe(true);
      }
      const inherited = graph.nodes.filter(
        (n) => n.kind === "event" && n.properties.event_name === "inherited",
      );
      expect(inherited).toHaveLength(1);
      const inheritedRelations = eventRelations.filter(
        (r) =>
          r.source_node_id === inherited[0]?.node_id ||
          r.target_node_id === inherited[0]?.node_id,
      );
      expect(inheritedRelations).toHaveLength(3);
      expect(
        inheritedRelations.every((r) => r.resolution === "candidate"),
      ).toBe(true);
      await client.ping();
    } finally {
      await client.close();
      await transport.close();
    }
  },
  120_000,
);
