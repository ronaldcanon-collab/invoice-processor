# Invoice Processor

AI-powered invoice data extraction. Upload PDF or image invoices, review and edit extracted data, export to Excel.

**Works on:** Desktop, iOS Safari, Android Chrome — any browser.

---

## Deploy to Vercel (free, ~10 minutes)

### Step 1 — Get an Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up / log in → **API Keys** → **Create Key**
3. Copy the key (starts with `sk-ant-...`) — you'll need it in Step 4

### Step 2 — Put the code on GitHub

1. Go to [github.com](https://github.com) → **New repository** → name it `invoice-processor` → **Create**
2. Upload all the files from this folder (drag & drop into the GitHub web UI), or use git:

```bash
cd invoice-processor
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/invoice-processor.git
git push -u origin main
```

### Step 3 — Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) → **Sign up with GitHub** (free)
2. Click **Add New → Project**
3. Select your `invoice-processor` repository → **Import**
4. Vercel auto-detects Vite. Leave all settings as default → click **Deploy**

### Step 4 — Add your API key

1. In Vercel dashboard → your project → **Settings** → **Environment Variables**
2. Add:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** `sk-ant-...` (your key from Step 1)
   - **Environments:** Production ✓, Preview ✓, Development ✓
3. Click **Save**
4. Go to **Deployments** → click the three dots on your latest deployment → **Redeploy**

Your app is now live at `https://invoice-processor-xxx.vercel.app` 🎉

---

## Local development

```bash
# Install dependencies
npm install

# Install Vercel CLI
npm install -g vercel

# Log in to Vercel
vercel login

# Link to your Vercel project (run once)
vercel link

# Copy env template and add your key
cp .env.example .env.local
# Edit .env.local and set ANTHROPIC_API_KEY=sk-ant-...

# Run locally (uses Vercel dev server so /api/extract works)
vercel dev
```

Open [http://localhost:3000](http://localhost:3000)

> **Note:** Use `vercel dev` (not `npm run dev`) for local development — it runs the serverless function at `/api/extract` alongside Vite.

---

## Project structure

```
invoice-processor/
├── api/
│   └── extract.js        # Serverless function — secure Anthropic API proxy
├── src/
│   ├── main.jsx           # React entry point
│   └── App.jsx            # Full invoice processor UI
├── public/
├── index.html
├── package.json
├── vite.config.js
└── vercel.json
```

## How it works

```
Browser  →  POST /api/extract (image + prompt)
                    ↓
            Vercel Serverless Function
            (adds ANTHROPIC_API_KEY)
                    ↓
            Anthropic Claude API
                    ↓
            JSON invoice data
                    ↓
Browser  ←  Extracted fields
```

The API key **never** leaves the server. All devices (iOS, Android, desktop) hit the same `/api/extract` endpoint over HTTPS.

---

## Supported file types

- PDF (rendered via PDF.js, page 1)
- PNG, JPG/JPEG, WEBP
- HEIC/HEIF (iPhone photos — auto-converted)
- BMP, GIF

## Features

- AI extraction of: Invoice No., Dates, Vendor (name + address), Bill To (name + address), Amount, Currency, Tax, PO Number, Payment Terms, Bank Details, Line Items
- Multi-file queue (up to 3 files)
- Manual editing of all extracted fields
- Edit previously saved invoices
- Export to Excel (.xlsx) with:
  - Main "Invoices" sheet
  - Per-invoice line items sheet (hyperlinked)
  - Back-links from line item sheets to main sheet
