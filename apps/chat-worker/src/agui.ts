// The Bridge, chat dialect — re-exported from contracts (saas-copilot-surface
// CX1): the pure translators moved to @saas/contracts/agui-bridge so
// agents-worker's relay can drive the attach dialect too. This module keeps
// the worker-local import path (and the CX0 test surface) stable.

export {
  chatBridgeInitial,
  translateChatFrame,
  translateChatFrames,
  type ChatBridgeState,
  type ChatV1Frame,
} from "@saas/contracts/agui-bridge";
