// The subset of @earendil-works/pi-ai's message types that pi-vcc's core reads.
// src/adapter.ts builds these from OpenCode session messages.

export interface TextContent {
  type: "text"
  text: string
}

export interface ThinkingContent {
  type: "thinking"
  thinking: string
}

export interface ImageContent {
  type: "image"
  data: string
  mimeType: string
}

export interface ToolCall {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, any>
}

export interface UserMessage {
  role: "user"
  content: string | (TextContent | ImageContent)[]
  timestamp: number
}

export interface AssistantMessage {
  role: "assistant"
  content: (TextContent | ThinkingContent | ToolCall)[]
  timestamp: number
}

export interface ToolResultMessage {
  role: "toolResult"
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  isError: boolean
  timestamp: number
}

/** pi's user `!command` messages; OpenCode's `shell` messages map to these. */
export interface BashExecutionMessage {
  role: "bashExecution"
  command: string
  output: string
  exitCode: number | undefined
  timestamp: number
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage | BashExecutionMessage
