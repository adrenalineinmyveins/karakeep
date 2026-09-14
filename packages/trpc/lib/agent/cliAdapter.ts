/**
 * CLI 子进程 Agent Adapter（trae-cli 型档案）
 *
 * 实现 AgentInterface：spawn CLI 子进程，一次性出结果（非流式）。
 * - 无状态拼接：每次调用把 systemPrompt + 对话历史 + 最新消息拼进 prompt
 * - 只读工具白名单：通过 --allowed-tool 限制为读取/搜索类工具
 * - 超时：--query-timeout 传给 CLI 优雅超时，本地定时器 +30s 兜底强杀
 * - Windows：.cmd shim 需经 cmd.exe 启动；进程树用 taskkill /T /F 击杀
 * - 输出解析：--json 单 JSON 对象（成功含 agent_states[].messages[]，
 *   失败时 exit code 仍为 0，错误在顶层 error 字段 —— 实测确认）
 */

import { spawn } from "node:child_process";
import os from "node:os";

import type { AgentEvent, AgentInterface, ToolDefinition } from "./sdkAdapter";

/** 只读工具白名单（TODO：traecli 工具名未实测确认，端到端验证时校正） */
const TRAE_ALLOWED_TOOLS = "Read,Grep,Glob,WebSearch,WebFetch";

export interface CliAgentConfig {
  command: string;
  timeoutMinutes: number;
  systemPrompt: string;
}

export interface CliAgentParams {
  history: { role: "user" | "assistant"; content: string }[];
  tools: ToolDefinition[];
}

/** cmd.exe 引号转义：内部 " 加倍 */
function quoteWin(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

/** 击杀进程树：Windows 用 taskkill，其他平台 kill 进程组 */
function killTree(pid: number) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 进程已退出
    }
  }
}

/** 无状态拼接：systemPrompt + 历史 + 最新消息 */
function buildPrompt(
  config: CliAgentConfig,
  params: CliAgentParams,
  text: string,
): string {
  const parts: string[] = [];
  if (config.systemPrompt) {
    parts.push(`[系统指令]\n${config.systemPrompt}`);
  }
  if (params.history.length > 0) {
    const transcript = params.history
      .map(
        (m) =>
          `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 2000)}`,
      )
      .join("\n\n");
    parts.push(`[与用户的此前对话]\n${transcript}`);
  }
  parts.push(`[用户的最新消息]\n${text}`);
  return parts.join("\n\n---\n\n");
}

/** 从 CLI JSON 输出提取最终回复文本 */
function extractFinalText(raw: string): string | null {
  // 逐行找 JSON 对象（CLI 可能在 JSON 前输出日志行）
  const lines = raw.split(/\r?\n/);
  let parsed: unknown = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) {
      continue;
    }
    try {
      parsed = JSON.parse(t);
      break;
    } catch {
      // 尝试整段（JSON 跨行的情况）
    }
  }
  if (parsed === null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 无 JSON：整体当纯文本（截断后返回）
      const text = raw.trim();
      return text.length > 0 ? text : null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // 失败路径：错误在顶层 error 字段（实测 exit code 仍为 0）
  if (typeof obj.error === "string" && obj.error.length > 0) {
    throw new Error(`CLI agent 执行失败: ${obj.error}`);
  }

  // 成功路径：agent_states[].messages[] 中最后一条 assistant 消息
  if (Array.isArray(obj.agent_states)) {
    for (const state of obj.agent_states) {
      if (typeof state !== "object" || state === null) {
        continue;
      }
      const messages = (state as Record<string, unknown>).messages;
      if (!Array.isArray(messages)) {
        continue;
      }
      const assistantMsgs = messages.filter(
        (m) =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).role === "assistant",
      );
      const last = assistantMsgs[assistantMsgs.length - 1] as
        | Record<string, unknown>
        | undefined;
      if (last) {
        const content = last.content;
        if (typeof content === "string" && content.trim()) {
          return content;
        }
        if (Array.isArray(content)) {
          const text = content
            .map((c) =>
              typeof c === "object" &&
              c !== null &&
              (c as Record<string, unknown>).type === "text"
                ? String((c as Record<string, unknown>).text ?? "")
                : "",
            )
            .join("");
          if (text.trim()) {
            return text;
          }
        }
      }
    }
  }

  // 回退启发式：常见回复键，取最长候选
  const REPLY_KEYS = [
    "result",
    "message",
    "content",
    "text",
    "response",
    "assistantMessage",
    "output",
  ] as const;
  let best: string | null = null;
  for (const key of REPLY_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) {
      if (!best || v.length > best.length) {
        best = v;
      }
    }
  }
  return best;
}

export function createCliAgent(
  config: CliAgentConfig,
  params: CliAgentParams,
): AgentInterface & { prompt(text: string): Promise<void> } {
  const handlers = new Set<(event: AgentEvent) => void>();
  let child: ReturnType<typeof spawn> | null = null;
  let aborted = false;

  const emit = (event: AgentEvent) => {
    for (const h of handlers) {
      try {
        h(event);
      } catch {
        // handler 异常不阻断其他订阅者
      }
    }
  };

  return {
    async prompt(text: string): Promise<void> {
      // 无状态拼接 + CLI 参数
      const promptText = buildPrompt(config, params, text);
      const args = [
        "-p",
        "--json",
        "--allowed-tool",
        TRAE_ALLOWED_TOOLS,
        "--query-timeout",
        `${config.timeoutMinutes}m`,
        promptText,
      ];

      // Windows: npm 全局安装的 CLI 是 .cmd shim，必须经 cmd.exe 启动
      const isWin = process.platform === "win32";
      const commandLine = isWin
        ? `${config.command} ${args.map(quoteWin).join(" ")}`
        : null;

      await new Promise<void>((resolve, reject) => {
        child = isWin
          ? spawn("cmd.exe", ["/c", commandLine!], {
              cwd: os.tmpdir(),
              windowsHide: true,
              windowsVerbatimArguments: true,
            })
          : spawn(config.command, args, {
              cwd: os.tmpdir(),
            });

        let stdout = "";
        let stderr = "";
        // UTF-8 解码（Windows 默认 GBK 会乱码）
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        child.stdout!.on("data", (d: string) => {
          stdout += d;
        });
        child.stderr!.on("data", (d: string) => {
          stderr += d;
        });

        // 本地兜底超时：CLI 优雅超时 + 30s 缓冲后强杀进程树
        const timer = setTimeout(
          () => {
            if (child?.exitCode === null) {
              killTree(child.pid!);
            }
            reject(
              new Error(
                `CLI agent 超时（${config.timeoutMinutes} 分钟）：请检查任务是否过重，或在档案设置中调大超时`,
              ),
            );
          },
          config.timeoutMinutes * 60_000 + 30_000,
        );

        child.on("error", (err) => {
          clearTimeout(timer);
          reject(
            new Error(
              `无法启动 CLI（${config.command}）：${err.message}。请确认已安装并在 PATH 中`,
            ),
          );
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (aborted) {
            reject(new Error("已中止"));
            return;
          }
          try {
            if (code !== 0 && !stdout.trim()) {
              reject(
                new Error(
                  `CLI 退出码 ${code}${stderr ? `：${stderr.slice(0, 500)}` : ""}`,
                ),
              );
              return;
            }
            const finalText = extractFinalText(stdout);
            if (finalText === null) {
              reject(
                new Error(
                  `CLI 未返回有效内容${stderr ? `：${stderr.slice(0, 500)}` : ""}`,
                ),
              );
              return;
            }
            // 成功：token 一次性下发（UI 端展示为"执行中→一次性出结果"）
            emit({ type: "token_delta", delta: finalText });
            emit({ type: "message_complete", content: finalText });
            resolve();
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      });
    },

    subscribe(handler: (event: AgentEvent) => void): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    abort(): void {
      aborted = true;
      if (child?.exitCode === null) {
        killTree(child.pid!);
      }
    },
  };
}
