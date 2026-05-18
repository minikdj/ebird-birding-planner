// server.js — MCP boilerplate and request-dispatch loop.
//
// Imports tool handlers from ./handlers/index.js, wires them into the
// MCP Server's ListTools / CallTool request handlers, and connects over stdio.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { TOOLS, TOOL_HANDLERS } from './handlers/index.js';
import { createContext, InputError } from './handlers/_shared.js';

/**
 * Build and start an MCP server over stdio.
 *
 * @param {{ clients: object, config: object, lifeList: object|null }} deps
 */
export async function startServer({ clients, config, lifeList }) {
  const ctx = createContext({ clients, config, lifeList });

  const server = new Server(
    { name: 'ebird-birding-planner', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const handler = TOOL_HANDLERS.get(name);
      if (!handler) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }
      const result = await handler(args ?? {}, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (error instanceof InputError) {
        return {
          content: [{ type: 'text', text: error.message }],
          isError: true,
        };
      }
      process.stderr.write(`Error in ${name}: ${error.message}\n${error.stack}\n`);
      return {
        content: [{ type: 'text', text: 'An error occurred fetching birding data. Check server logs for details.' }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('ebird-birding-planner MCP server running\n');
  return server;
}
