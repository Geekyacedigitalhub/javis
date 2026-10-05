# JARVIS API

The API is the entry point for clients.

Current vertical slice:
- typed request/response contracts
- AI orchestration boundary
- tool registry exposure
- safe starter tool
- conversation ID generation

The model adapter is intentionally isolated so the provider can be connected without coupling the rest of JARVIS to one SDK.
