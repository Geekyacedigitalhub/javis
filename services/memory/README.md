# JARVIS Memory

Memory is provider-independent and separates conversation history, user memories, and project/task context.

Implementations:
- InMemoryStore for local development and fallback
- PostgresMemoryStore for persistent storage

Set DATABASE_URL to use Postgres automatically. Run migrations/001_initial.sql against the database before starting JARVIS with a database connection.

The storage contract stays independent from the AI orchestration layer, so retrieval, ranking, summarization, and deletion policies can evolve without changing the assistant core.
