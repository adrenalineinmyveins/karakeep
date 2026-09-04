import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import TurndownService from "turndown";

import { createSaiyeClient } from "@saiye/sdk";

import packageJson from "../package.json";

const addr = process.env.SAIYE_API_ADDR;
const apiKey = process.env.SAIYE_API_KEY;

const getCustomHeaders = () => {
  try {
    return process.env.SAIYE_CUSTOM_HEADERS
      ? JSON.parse(process.env.SAIYE_CUSTOM_HEADERS)
      : {};
  } catch (e) {
    console.error("Failed to parse SAIYE_CUSTOM_HEADERS", e);
    return {};
  }
};

export const saiyeClient = createSaiyeClient({
  baseUrl: `${addr}/api/v1`,
  headers: {
    ...getCustomHeaders(),
    "Content-Type": "application/json",
    authorization: `Bearer ${apiKey}`,
  },
});

export const mcpServer = new McpServer({
  name: "Saiye",
  version: packageJson.version,
});

export const turndownService = new TurndownService();
