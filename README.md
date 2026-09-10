# DecisionOS

```
decisionos/
├── backend/    Express API — auth, Postgres-backed analytics, the AI
│               Advisor/Chat tool-calling loop. See backend/README.md.
└── frontend/   Vite + React app (DecisionOS.jsx does the heavy lifting;
                everything else here is just the scaffold to run it).
```

## Run it

**1. Backend**
```bash
cd backend
npm install
cp .env.example .env
# fill in DATABASE_URL, JWT_SECRET, CONFIG_ENCRYPTION_KEY, ANTHROPIC_API_KEY
npm start        # listens on :8787 by default
```

**2. Frontend**
```bash
cd frontend
npm install
cp .env.example .env    # VITE_DECISIONOS_API_BASE, defaults to http://localhost:8787
npm run dev              # http://localhost:5173
```

Register an organization from the login screen, then connect real data
from the onboarding flow (Excel upload) or continue with demo data to
browse the UI without a backend connection — the AI Advisor and Chat
stay disabled in demo mode since there's no organization data on the
server for them to reason about.

See `backend/README.md` for the API surface, data model, and the
Anthropic tool-calling loop.
