# JARVIS AI

The AI service owns orchestration. It receives conversation messages and the currently available tool definitions, then delegates generation to a model adapter.

Provider credentials and SDK-specific code should stay behind the adapter boundary.
