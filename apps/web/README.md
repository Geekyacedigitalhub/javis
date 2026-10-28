# FROSH Web Control Center

The Next.js Control Center is the authenticated web client for FROSH. It provides
conversation history, live assistant-status visibility, approvals, missions,
automations, memory review, devices, integrations, and browser voice controls.

The client deliberately does not claim a live AI model is available until the
server reports one. Configure a server-side provider (`GEMINI_API_KEY` with
`FROSH_AI_PROVIDER=gemini` for the no-cost Gemini route, or `OPENAI_API_KEY`)
in both Render containers; never expose that key through `NEXT_PUBLIC_*`.
