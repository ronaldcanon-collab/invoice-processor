import { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";

/* ─── Field Definitions ─────────────────────────────────────────────────── */
const FIELDS = [
  { key: "invoiceNo",     label: "Invoice No.",       placeholder: "INV-001",               icon: "#",  group: "header" },
  { key: "invoiceDate",   label: "Invoice Date",      placeholder: "2024-01-15",            icon: "📅", group: "header" },
  { key: "dueDate",       label: "Due Date",          placeholder: "2024-02-15",            icon: "⏰", group: "header" },
  { key: "paymentTerms",  label: "Payment Terms",     placeholder: "Net 30",                icon: "📋", group: "header" },
  { key: "vendorName",    label: "Vendor Name",       placeholder: "Acme Corp",             icon: "🏢", group: "vendor" },
  { key: "vendorAddress", label: "Vendor Address",    placeholder: "123 Main St, City…",    icon: "📍", group: "vendor", wide: true },
  { key: "billToName",    label: "Bill To — Name",    placeholder: "Client / Company",      icon: "👤", group: "billto" },
  { key: "billToAddress", label: "Bill To — Address", placeholder: "456 Oak Ave, City…",    icon: "📍", group: "billto", wide: true },
  { key: "amount",        label: "Total Amount",      placeholder: "1,500.00",              icon: "💰", group: "money"  },
  { key: "currency",      label: "Currency",          placeholder: "USD",                   icon: "💱", group: "money"  },
  { key: "taxAmount",     label: "Tax Amount",        placeholder: "150.00",                icon: "🧾", group: "money"  },
  { key: "poNumber",      label: "PO Number",         placeholder: "PO-2024-001",           icon: "📝", group: "money"  },
  { key: "description",   label: "Notes / Summary",   placeholder: "Professional services…",icon: "📦", wide: true },
  { key: "bankDetails",   label: "Bank / Payment",    placeholder: "Account, SWIFT, IBAN…", icon: "🏦", wide: true },
];

const EMPTY_FORM   = Object.fromEntries(FIELDS.map(f => [f.key, ""]));
const EMPTY_LINE   = { description: "", qty: "", unitPrice: "", amount: "" };
const MAX_FILES    = 3;
const GROUP_LABELS = { header: null, vendor: "From (Vendor)", billto: "Bill To", money: "Financials" };

const EXTRACTION_PROMPT = `You are an invoice data extractor. Your ENTIRE response must be a single valid JSON object — no prose, no markdown, no backticks, no explanation before or after.

Extract every field visible on this invoice and return this exact structure:
{"invoiceNo":"","invoiceDate":"","dueDate":"","paymentTerms":"","vendorName":"","vendorAddress":"","billToName":"","billToAddress":"","amount":"","currency":"","taxAmount":"","poNumber":"","description":"","bankDetails":"","lineItems":[{"description":"","qty":"","unitPrice":"","amount":""}]}

Rules:
- amounts: numeric string only e.g. "4299.00"
- dates: YYYY-MM-DD format
- currency: 3-letter code e.g. "HKD", "USD"
- lineItems: include ALL line items found; use [] if none
- Extract ALL text faithfully including Chinese/Japanese/Korean characters — do not skip or translate non-English text
- empty string "" for any field not present
- DO NOT wrap in markdown. Start your response with { and end with }`;

/* ─── Image helpers ─────────────────────────────────────────────────────── */
function normalizeMime(file) {
  const t   = (file.type || "").toLowerCase();
  const ext = file.name.split(".").pop().toLowerCase();
  if (t === "application/pdf" || ext === "pdf") return "application/pdf";
  if (t === "image/jpeg" || t === "image/jpg")  return "image/jpeg";
  if (t === "image/png")  return "image/png";
  if (t === "image/webp") return "image/webp";
  if (t === "image/gif")  return "image/gif";
  return "image/jpeg";
}

function smartResize(canvas, maxLong, minWidth, quality) {
  let w = canvas.width, h = canvas.height;
  const portrait = h > w;
  let scale = 1;
  if (portrait) {
    scale = Math.min(maxLong / h, 1);
    if (w * scale < minWidth) scale = minWidth / w;
  } else {
    scale = Math.min(maxLong / w, 1);
  }
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const c2 = document.createElement("canvas");
  c2.width = nw; c2.height = nh;
  const ctx = c2.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, nw, nh);
  ctx.drawImage(canvas, 0, 0, nw, nh);
  return c2.toDataURL("image/jpeg", quality).split(",")[1];
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error("Image failed to load"));
      img.onload  = () => {
        // Draw source to canvas first
        const src = document.createElement("canvas");
        src.width = img.width; src.height = img.height;
        const ctx = src.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, src.width, src.height);
        ctx.drawImage(img, 0, 0);
        // Multi-pass: keep width readable for CJK text
        let b64 = smartResize(src, 2000, 900, 0.82);
        if (b64.length * 0.75 > 700 * 1024) b64 = smartResize(src, 2000, 900, 0.65);
        if (b64.length * 0.75 > 700 * 1024) b64 = smartResize(src, 1600, 800, 0.60);
        resolve({ base64: b64, mediaType: "image/jpeg" });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function pdfToImageBase64(file) {
  if (!window.pdfjsLib) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = res; s.onerror = () => rej(new Error("Failed to load PDF.js"));
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const pdf      = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const page     = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas   = document.createElement("canvas");
  canvas.width   = viewport.width; canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  let b64 = smartResize(canvas, 2000, 900, 0.85);
  if (b64.length * 0.75 > 700 * 1024) b64 = smartResize(canvas, 2000, 900, 0.70);
  if (b64.length * 0.75 > 700 * 1024) b64 = smartResize(canvas, 1600, 800, 0.60);
  return { base64: b64, mediaType: "image/jpeg" };
}

/* ─── JSON extraction (robust) ──────────────────────────────────────────── */
function extractJSON(raw) {
  let text  = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = text.indexOf("{");
  if (start === -1) throw new Error("No JSON object in response:\n" + text.slice(0, 300));
  let depth = 0, end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  let s = end !== -1 ? text.slice(start, end + 1) : text.slice(start);
  if (end === -1) {
    const opens = (s.match(/\[/g)||[]).length - (s.match(/\]/g)||[]).length;
    const objs  = (s.match(/\{/g)||[]).length - (s.match(/\}/g)||[]).length;
    s = s.replace(/,\s*"[^"]*"?\s*:?\s*[^,}\]]*$/, "");
    s += "]".repeat(Math.max(0, opens)) + "}".repeat(Math.max(0, objs));
  }
  return JSON.parse(s);
}

/* ─── API call — via /api/extract proxy ─────────────────────────────────── */
async function extractInvoice(file) {
  const mime  = normalizeMime(file);
  const isPdf = mime === "application/pdf";

  const { base64, mediaType } = isPdf
    ? await pdfToImageBase64(file)
    : await compressImage(file);

  // Call our secure proxy — API key lives only on the server
  let rawText = "";
  try {
    const res = await fetch("/api/extract", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ imageBase64: base64, mediaType, prompt: EXTRACTION_PROMPT }),
    });

    rawText = await res.text();

    if (!res.ok) {
      try {
        const e = JSON.parse(rawText);
        throw new Error(e.error || e.message || `Server error ${res.status}`);
      } catch (pe) {
        if (pe.message && !pe.message.startsWith("Unexpected")) throw pe;
        throw new Error(`Server error ${res.status}: ${rawText.slice(0, 200)}`);
      }
    }

    const data = JSON.parse(rawText);
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    if (!data.content?.length) throw new Error("Empty response from API");

    const raw    = data.content.map(c => c.text || "").join("");
    const parsed = extractJSON(raw);
    const form   = Object.fromEntries(FIELDS.map(f => [f.key, parsed[f.key] || ""]));
    return { form, lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems : [] };

  } catch (err) {
    if (rawText && !err.message.includes(rawText.slice(0, 20))) {
      throw new Error(`${err.message}\n\nRaw: ${rawText.slice(0, 200)}`);
    }
    throw err;
  }
}

/* ─── Excel Export ──────────────────────────────────────────────────────── */
function slugSheet(name, idx) {
  return (name || `Invoice_${idx + 1}`).replace(/[:\\/?*[\]]/g, "_").slice(0, 28);
}

function exportExcel(saved) {
  if (!saved.length) { alert("No saved invoices to export."); return; }
  const wb = XLSX.utils.book_new();

  const mainRows = saved.map((inv, idx) => {
    const hasLines  = inv.lineItems?.length > 0;
    const sheetName = hasLines ? slugSheet(inv.form.invoiceNo || inv.form.vendorName, idx) : null;
    return {
      "Invoice No.":      inv.form.invoiceNo     || "",
      "Vendor Name":      inv.form.vendorName     || "",
      "Vendor Address":   inv.form.vendorAddress  || "",
      "Bill To Name":     inv.form.billToName     || "",
      "Bill To Address":  inv.form.billToAddress  || "",
      "Invoice Date":     inv.form.invoiceDate    || "",
      "Due Date":         inv.form.dueDate        || "",
      "Amount":           inv.form.amount         || "",
      "Currency":         inv.form.currency       || "",
      "Tax Amount":       inv.form.taxAmount      || "",
      "Payment Terms":    inv.form.paymentTerms   || "",
      "PO Number":        inv.form.poNumber       || "",
      "Notes":            inv.form.description    || "",
      "Bank Details":     inv.form.bankDetails    || "",
      "File Name":        inv.fileName            || "",
      "Line Items Sheet": sheetName ? `See: ${sheetName}` : "",
    };
  });

  const ws = XLSX.utils.json_to_sheet(mainRows);
  ws["!cols"] = [14,22,28,22,28,14,14,12,10,12,14,14,30,30,24,22].map(w => ({ wch: w }));
  saved.forEach((inv, idx) => {
    if (!inv.lineItems?.length) return;
    const sn   = slugSheet(inv.form.invoiceNo || inv.form.vendorName, idx);
    const cell = XLSX.utils.encode_cell({ r: idx + 1, c: 15 });
    if (ws[cell]) ws[cell].l = { Target: `#'${sn}'!A1` };
  });
  XLSX.utils.book_append_sheet(wb, ws, "Invoices");

  saved.forEach((inv, idx) => {
    if (!inv.lineItems?.length) return;
    const sn      = slugSheet(inv.form.invoiceNo || inv.form.vendorName, idx);
    const mainRow = idx + 2;
    const info = [
      ["Invoice No.",  inv.form.invoiceNo   || ""],
      ["Vendor",       inv.form.vendorName  || ""],
      ["Bill To",      inv.form.billToName  || ""],
      ["Invoice Date", inv.form.invoiceDate || ""],
      ["Due Date",     inv.form.dueDate     || ""],
      ["Total",        inv.form.amount      || ""],
      [], ["LINE ITEMS"],
    ];
    const lineRows = inv.lineItems.map(li => ({
      "Description": li.description || "",
      "Qty":         li.qty         || "",
      "Unit Price":  li.unitPrice   || "",
      "Amount":      li.amount      || "",
    }));
    const liWs = XLSX.utils.aoa_to_sheet(info);
    XLSX.utils.sheet_add_json(liWs, lineRows, { origin: info.length });
    liWs["!cols"] = [{ wch: 44 }, { wch: 10 }, { wch: 14 }, { wch: 14 }];
    const cell = XLSX.utils.encode_cell({ r: 0, c: 1 });
    if (liWs[cell]) liWs[cell].l = { Target: `#Invoices!A${mainRow}` };
    XLSX.utils.book_append_sheet(wb, liWs, sn);
  });

  XLSX.writeFile(wb, `invoices_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/* ─── UI Helpers ─────────────────────────────────────────────────────────── */
function fieldStyle(value) {
  const filled = !!value;
  return {
    width: "100%", background: filled ? "#0e1a2e" : "#090d18",
    border: `1px solid ${filled ? "#2d6a9f" : "#192130"}`,
    borderRadius: 7, color: filled ? "#e2ecfc" : "#3a4a60",
    padding: "8px 11px", fontSize: 12, transition: "all 0.18s", fontFamily: "inherit",
  };
}

function Badge({ color = "#64748b", children }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 9px",
      borderRadius: 20, background: color + "22", border: `1px solid ${color}44`,
      color, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em" }}>
      {children}
    </span>
  );
}

function StatusBadge({ status }) {
  const map = {
    pending:    ["#64748b", "Pending"],
    extracting: ["#f59e0b", "Extracting…"],
    ready:      ["#10b981", "Ready"],
    error:      ["#ef4444", "Error"],
    saved:      ["#6366f1", "Saved"],
  };
  const [color, label] = map[status] || map.pending;
  return <Badge color={color}>{label}</Badge>;
}

/* ─── InvoicePreview ────────────────────────────────────────────────────── */
function InvoicePreview({ item }) {
  const [failed, setFailed] = useState(false);

  // Reset failed state when item changes
  const prevUrlRef = useState(null);
  if (prevUrlRef[0] !== (item?.previewUrl || null)) {
    prevUrlRef[0] = item?.previewUrl || null;
    if (failed) setFailed(false);
  }

  if (!item || !item.fileName) return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", color:"#1e2a3b", gap:8 }}>
      <div style={{ fontSize:40 }}>🔍</div>
      <div style={{ fontSize:12, color:"#2a3a4a", fontWeight:600 }}>Invoice Preview</div>
      <div style={{ fontSize:10, color:"#1a2a36", textAlign:"center", maxWidth:180, lineHeight:1.6 }}>Select a file from the queue to preview it here</div>
    </div>
  );
  const isImage = item.fileType?.startsWith("image/");
  return (
    <div style={{ height:"100%", display:"flex", flexDirection:"column" }}>
      <div style={{ padding:"10px 14px", borderBottom:"1px solid #151c2b", fontSize:10, color:"#475569", fontWeight:700, letterSpacing:"0.07em", textTransform:"uppercase", display:"flex", gap:6, alignItems:"center" }}>
        {isImage ? "🖼" : "📄"} {item.fileName || "Invoice"}
      </div>
      <div style={{ flex:1, padding:10, overflow:"hidden", display:"flex", flexDirection:"column", minHeight:0 }}>
        {!item.previewUrl || failed ? (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", flex:1, color:"#334155", gap:10, textAlign:"center", padding:20 }}>
            <div style={{ fontSize:44 }}>📄</div>
            <div style={{ fontSize:12, fontWeight:700, color:"#475569" }}>{item.fileName}</div>
            <div style={{ fontSize:11, lineHeight:1.7 }}>
              {!item.previewUrl ? "Editing saved invoice — original file not available" : "PDF preview unavailable.\nData extracted — review fields."}
            </div>
          </div>
        ) : isImage ? (
          <img src={item.previewUrl} alt="Invoice" onError={() => setFailed(true)}
            style={{ width:"100%", height:"100%", objectFit:"contain", borderRadius:8, background:"#fff" }} />
        ) : (
          <iframe key={item.previewUrl} src={item.previewUrl + "#toolbar=0&navpanes=0"}
            title="Invoice PDF" onError={() => setFailed(true)}
            style={{ flex:1, width:"100%", border:"none", borderRadius:8, background:"#fff", minHeight:300 }} />
        )}
      </div>
    </div>
  );
}

/* ─── LineItemsTable ─────────────────────────────────────────────────────── */
function LineItemsTable({ items, onChange }) {
  const update  = (i, k, v) => onChange(items.map((r, j) => j === i ? { ...r, [k]: v } : r));
  const addRow  = ()        => onChange([...items, { ...EMPTY_LINE }]);
  const delRow  = i         => onChange(items.filter((_, j) => j !== i));
  const th = { padding:"7px 10px", fontSize:10, fontWeight:700, color:"#3a5070", letterSpacing:"0.06em", textTransform:"uppercase", textAlign:"left", background:"#080d17", whiteSpace:"nowrap" };
  return (
    <div style={{ gridColumn:"1/-1", marginTop:6 }}>
      <div style={{ fontSize:10, fontWeight:700, color:"#3a5070", letterSpacing:"0.07em", textTransform:"uppercase", marginBottom:7, display:"flex", alignItems:"center", gap:7 }}>
        📦 Line Items {items.length > 0 && <Badge color="#38bdf8">{items.length}</Badge>}
      </div>
      <div style={{ border:"1px solid #151c2b", borderRadius:10, overflow:"hidden" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width:"42%" }}>Description</th>
              <th style={{ ...th, width:"12%" }}>Qty</th>
              <th style={{ ...th, width:"20%" }}>Unit Price</th>
              <th style={{ ...th, width:"18%" }}>Amount</th>
              <th style={{ ...th, width:"8%"  }}></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={5} style={{ padding:"14px", textAlign:"center", fontSize:11, color:"#1e2a3b" }}>
                No line items — add manually or they'll auto-populate after extraction
              </td></tr>
            )}
            {items.map((row, i) => (
              <tr key={i} style={{ borderTop:"1px solid #0d1220" }}>
                {["description","qty","unitPrice","amount"].map(k => (
                  <td key={k} style={{ padding:"3px 4px" }}>
                    <input value={row[k]} onChange={e => update(i, k, e.target.value)}
                      placeholder={k === "description" ? "Item description" : "0"}
                      style={{ ...fieldStyle(row[k]), fontSize:12 }} />
                  </td>
                ))}
                <td style={{ padding:"3px 4px", textAlign:"center" }}>
                  <button onClick={() => delRow(i)} style={{ background:"none", border:"none", color:"#1e2a3b", cursor:"pointer", fontSize:14, transition:"color 0.15s" }}
                    onMouseOver={e => e.target.style.color="#ef4444"} onMouseOut={e => e.target.style.color="#1e2a3b"}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={addRow}
        style={{ marginTop:7, background:"transparent", border:"1px dashed #1a2a3a", color:"#3a5070", padding:"5px 13px", borderRadius:7, cursor:"pointer", fontSize:11, fontWeight:600, transition:"all 0.15s" }}
        onMouseOver={e => { e.currentTarget.style.borderColor="#38bdf8"; e.currentTarget.style.color="#38bdf8"; }}
        onMouseOut={e => { e.currentTarget.style.borderColor="#1a2a3a"; e.currentTarget.style.color="#3a5070"; }}>
        + Add Row
      </button>
    </div>
  );
}

/* ─── SectionLabel ───────────────────────────────────────────────────────── */
function SectionLabel({ label }) {
  return (
    <div style={{ gridColumn:"1/-1", display:"flex", alignItems:"center", gap:8, marginTop:6 }}>
      <div style={{ fontSize:9, fontWeight:800, color:"#2d4a66", letterSpacing:"0.1em", textTransform:"uppercase" }}>{label}</div>
      <div style={{ flex:1, height:1, background:"#111c2a" }} />
    </div>
  );
}

/* ─── ReviewForm ─────────────────────────────────────────────────────────── */
function ReviewForm({ data, onChangeForm, onChangeLines, onSave, onDiscard, onAddMore, isSavedEdit }) {
  const { form, lineItems, fileName, status } = data;

  // Group fields for section headers
  const sections = [];
  let lastGroup = null;
  for (const f of FIELDS) {
    const g = f.group || "__";
    if (g !== lastGroup) { sections.push({ group: g, fields: [] }); lastGroup = g; }
    sections[sections.length - 1].fields.push(f);
  }

  return (
    <div style={{ animation:"fadeUp 0.25s ease", maxWidth:680, margin:"0 auto" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:18 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ fontSize:17, fontWeight:800, letterSpacing:"-0.025em" }}>
              {form.invoiceNo ? `Invoice ${form.invoiceNo}` : "Review Invoice"}
            </div>
            {isSavedEdit && <Badge color="#f59e0b">Editing Saved</Badge>}
          </div>
          <div style={{ fontSize:11, color:"#475569", marginTop:3, display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
            {fileName} {!isSavedEdit && <><span>·</span><StatusBadge status={status} /></>}
            {lineItems.length > 0 && <Badge color="#38bdf8">{lineItems.length} line items</Badge>}
          </div>
        </div>
        <div style={{ display:"flex", gap:7, flexShrink:0 }}>
          {!isSavedEdit && (
            <button onClick={onAddMore}
              style={{ background:"transparent", border:"1px solid #1e2a3b", color:"#475569", padding:"7px 13px", borderRadius:7, cursor:"pointer", fontSize:11, fontWeight:600, transition:"all 0.18s" }}
              onMouseOver={e => { e.currentTarget.style.borderColor="#38bdf8"; e.currentTarget.style.color="#38bdf8"; }}
              onMouseOut={e => { e.currentTarget.style.borderColor="#1e2a3b"; e.currentTarget.style.color="#475569"; }}>
              + Add More
            </button>
          )}
          <button onClick={onSave}
            style={{ background: isSavedEdit ? "linear-gradient(135deg,#f59e0b,#d97706)" : "linear-gradient(135deg,#10b981,#059669)", border:"none", color:"#fff", padding:"7px 18px", borderRadius:7, cursor:"pointer", fontSize:11, fontWeight:700, transition:"all 0.18s" }}>
            {isSavedEdit ? "Update ✓" : "Save ✓"}
          </button>
        </div>
      </div>

      {/* Fields by group */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        {sections.map(({ group, fields }) => (
          <React.Fragment key={group}>
            {GROUP_LABELS[group] && <SectionLabel label={GROUP_LABELS[group]} />}
            {fields.map(f => (
              <div key={f.key} style={{ gridColumn: f.wide ? "1/-1" : "auto" }}>
                <label style={{ display:"block", fontSize:9, fontWeight:700,
                  color: form[f.key] ? "#4a7499" : "#1e2a3b",
                  letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:4, transition:"color 0.2s" }}>
                  {f.icon} {f.label}
                </label>
                {f.wide ? (
                  <textarea value={form[f.key]} onChange={e => onChangeForm(f.key, e.target.value)}
                    placeholder={f.placeholder} rows={2}
                    style={{ ...fieldStyle(form[f.key]), resize:"vertical" }} />
                ) : (
                  <input type="text" value={form[f.key]} onChange={e => onChangeForm(f.key, e.target.value)}
                    placeholder={f.placeholder} style={fieldStyle(form[f.key])} />
                )}
              </div>
            ))}
          </React.Fragment>
        ))}
        <LineItemsTable items={lineItems} onChange={onChangeLines} />
      </div>

      {/* Footer */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:14, paddingTop:14, borderTop:"1px solid #0d1620" }}>
        <button onClick={onDiscard}
          style={{ background:"none", border:"1px solid #1a2436", color:"#334155", padding:"7px 14px", borderRadius:7, cursor:"pointer", fontSize:11, fontWeight:600, transition:"all 0.15s" }}
          onMouseOver={e => { e.currentTarget.style.borderColor="#ef4444"; e.currentTarget.style.color="#ef4444"; }}
          onMouseOut={e => { e.currentTarget.style.borderColor="#1a2436"; e.currentTarget.style.color="#334155"; }}>
          {isSavedEdit ? "Cancel" : "Discard"}
        </button>
        <button onClick={onSave}
          style={{ background: isSavedEdit ? "linear-gradient(135deg,#f59e0b,#d97706)" : "linear-gradient(135deg,#10b981,#059669)", border:"none", color:"#fff", padding:"8px 22px", borderRadius:7, cursor:"pointer", fontSize:12, fontWeight:700, transition:"all 0.18s" }}>
          {isSavedEdit ? "Update Invoice ✓" : "Save Invoice ✓"}
        </button>
      </div>
    </div>
  );
}

/* ─── App ─────────────────────────────────────────────────────────────────── */
export default function App() {
  const [queue,         setQueue]         = useState([]);
  const [reviewIdx,     setReviewIdx]     = useState(null);
  const [saved,         setSaved]         = useState([]);
  const [editSavedIdx,  setEditSavedIdx]  = useState(null);
  const [editSavedData, setEditSavedData] = useState(null);
  const [dragOver,      setDragOver]      = useState(false);
  const fileRef = useRef();

  const isSavedEdit    = editSavedIdx !== null;
  const reviewingQueue = !isSavedEdit && reviewIdx !== null ? queue[reviewIdx] : null;
  const reviewing      = isSavedEdit ? editSavedData : reviewingQueue;
  const previewItem    = isSavedEdit
    ? { fileName: editSavedData?.fileName, fileType: null, previewUrl: null }
    : reviewingQueue || null;

  /* Keep a ref to queue so callbacks always see latest state without stale closures */
  const queueRef = useRef(queue);
  queueRef.current = queue;

  /* Keep a ref to reviewIdx so we can check it inside async callbacks */
  const reviewIdxRef = useRef(reviewIdx);
  reviewIdxRef.current = reviewIdx;

  /* File handling */
  const addFiles = useCallback(async rawFiles => {
    const currentQueue = queueRef.current;
    const allowed = Array.from(rawFiles).filter(f => {
      const t   = (f.type || "").toLowerCase();
      const ext = f.name.split(".").pop().toLowerCase();
      return t === "application/pdf" || t.startsWith("image/") ||
        ["pdf","png","jpg","jpeg","webp","gif","heic","heif"].includes(ext);
    });
    const slots = MAX_FILES - currentQueue.length;
    if (slots <= 0) { alert(`Queue full — max ${MAX_FILES} files.`); return; }
    const toAdd = allowed.slice(0, slots);
    if (!toAdd.length) { alert("Please upload a PDF or image file (PNG, JPG, HEIC…)."); return; }

    const entries = toAdd.map(file => ({
      id: Math.random().toString(36).slice(2), file,
      fileName: file.name, fileType: normalizeMime(file),
      previewUrl: URL.createObjectURL(file),
      status: "pending", errorMsg: null,
      form: { ...EMPTY_FORM }, lineItems: [],
    }));

    // Add entries and auto-select the first one immediately so user sees the preview
    setQueue(prev => {
      const next = [...prev, ...entries];
      return next;
    });

    // Auto-open the first uploaded file if nothing is currently selected
    const firstIdx = currentQueue.length; // index of first new entry
    if (reviewIdxRef.current === null) {
      setEditSavedIdx(null);
      setEditSavedData(null);
      setReviewIdx(firstIdx);
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const entryIdx = currentQueue.length + i;
      setQueue(prev => prev.map(e => e.id === entry.id ? { ...e, status: "extracting" } : e));
      try {
        const { form, lineItems } = await extractInvoice(entry.file);
        setQueue(prev => prev.map(e => e.id === entry.id ? { ...e, status: "ready", form, lineItems } : e));
        // Auto-open this entry when done if nothing is selected yet
        if (reviewIdxRef.current === null) {
          setEditSavedIdx(null);
          setEditSavedData(null);
          setReviewIdx(entryIdx);
        }
      } catch (err) {
        setQueue(prev => prev.map(e => e.id === entry.id ? { ...e, status: "error", errorMsg: err.message } : e));
      }
    }
  }, []); // no deps — uses refs to avoid stale closures

  const onDrop = useCallback(e => {
    e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const updateQueueForm  = (k, v) => setQueue(p => p.map((e, i) => i === reviewIdx ? { ...e, form: { ...e.form, [k]: v } } : e));
  const updateQueueLines = items  => setQueue(p => p.map((e, i) => i === reviewIdx ? { ...e, lineItems: items } : e));
  const updateSavedForm  = (k, v) => setEditSavedData(p => ({ ...p, form: { ...p.form, [k]: v } }));
  const updateSavedLines = items  => setEditSavedData(p => ({ ...p, lineItems: items }));

  const saveQueue = () => {
    if (!reviewingQueue) return;
    setSaved(p => [...p, { form: reviewingQueue.form, lineItems: reviewingQueue.lineItems, fileName: reviewingQueue.fileName }]);
    setQueue(p => p.map((e, i) => i === reviewIdx ? { ...e, status: "saved" } : e));
    const next = queue.findIndex((e, i) => i !== reviewIdx && e.status !== "saved");
    setReviewIdx(next >= 0 ? next : null);
  };

  const updateSaved = () => {
    if (editSavedIdx === null) return;
    setSaved(p => p.map((s, i) => i === editSavedIdx ? { ...editSavedData } : s));
    setEditSavedIdx(null); setEditSavedData(null);
  };

  const openSavedForEdit = idx => {
    setReviewIdx(null);
    setEditSavedIdx(idx);
    setEditSavedData({ ...saved[idx] });
  };

  const cancelSavedEdit = () => { setEditSavedIdx(null); setEditSavedData(null); };

  const removeQueue = idx => {
    setQueue(p => p.filter((_, i) => i !== idx));
    if (reviewIdx === idx) setReviewIdx(null);
    else if (reviewIdx > idx) setReviewIdx(r => r - 1);
  };

  const retryExtract = async (item) => {
    setQueue(p => p.map(e => e.id === item.id ? { ...e, status: "extracting", errorMsg: null } : e));
    try {
      const { form, lineItems } = await extractInvoice(item.file);
      setQueue(p => p.map(e => e.id === item.id ? { ...e, status: "ready", form, lineItems } : e));
    } catch (err) {
      setQueue(p => p.map(e => e.id === item.id ? { ...e, status: "error", errorMsg: err.message } : e));
    }
  };

  /* ─── Render ─── */
  return (
    <div style={{ minHeight:"100vh", background:"#060a13", color:"#cdd9ee", fontFamily:"'Syne', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: #0a0f1c; }
        ::-webkit-scrollbar-thumb { background: #1a2436; border-radius: 4px; }
        input, textarea { outline: none; font-family: inherit; }
        input:focus, textarea:focus { border-color: #38bdf8 !important; box-shadow: 0 0 0 3px #38bdf81a !important; color: #e8f2ff !important; }
        @keyframes fadeUp  { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
        @keyframes shimmer { 0%,100%{opacity:.4} 50%{opacity:1} }
        .abtn:hover  { filter:brightness(1.12); transform:translateY(-1px); }
        .qpill:hover { background:#0c1828 !important; border-color:#38bdf844 !important; }
        .spill:hover { background:#120d00 !important; border-color:#f59e0b66 !important; cursor:pointer; }
      `}</style>

      {/* Header */}
      <header style={{ borderBottom:"1px solid #0d1520", padding:"12px 24px", display:"flex", alignItems:"center", justifyContent:"space-between", background:"#060a13f0", backdropFilter:"blur(8px)", position:"sticky", top:0, zIndex:20 }}>
        <div style={{ display:"flex", alignItems:"center", gap:11 }}>
          <div style={{ width:32, height:32, background:"linear-gradient(135deg,#38bdf8,#0ea5e9)", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", fontSize:15 }}>🧾</div>
          <div>
            <div style={{ fontSize:15, fontWeight:800, letterSpacing:"-0.03em" }}>Invoice Processor</div>
            <div style={{ fontSize:9, color:"#1e2a3b", letterSpacing:"0.1em", textTransform:"uppercase" }}>AI · Multi-file · Excel Export</div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {saved.length > 0 && <span style={{ fontSize:11, color:"#334155" }}>{saved.length} saved</span>}
          <button className="abtn" onClick={() => exportExcel(saved)}
            style={{ background:"linear-gradient(135deg,#0ea5e9,#0284c7)", border:"none", color:"#fff", padding:"7px 16px", borderRadius:7, cursor:"pointer", fontSize:11, fontWeight:700, transition:"all 0.18s" }}>
            ↓ Export Excel {saved.length > 0 ? `(${saved.length})` : ""}
          </button>
        </div>
      </header>

      {/* 3-col layout — flex so preview panel is always mounted */}
      <div style={{ display:"flex", flexDirection:"row", height:"calc(100vh - 56px)", overflow:"hidden" }}>

        {/* Sidebar */}
        <div style={{ width:240, flexShrink:0, borderRight:"1px solid #0d1520", display:"flex", flexDirection:"column", overflow:"hidden" }}>

          {/* Upload zone */}
          <div onDrop={onDrop}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => queue.length < MAX_FILES && fileRef.current.click()}
            style={{ margin:12, borderRadius:12, padding:"16px 10px", textAlign:"center",
              border:`2px dashed ${dragOver ? "#38bdf8" : "#12202e"}`,
              background: dragOver ? "#0a1828" : "#080d17",
              cursor: queue.length >= MAX_FILES ? "not-allowed" : "pointer",
              transition:"all 0.2s", opacity: queue.length >= MAX_FILES ? 0.4 : 1 }}>
            <div style={{ fontSize:22, marginBottom:4 }}>☁</div>
            <div style={{ fontSize:11, fontWeight:700, color:"#4a6a8a", marginBottom:2 }}>
              {queue.length >= MAX_FILES ? `Queue full (${MAX_FILES}/${MAX_FILES})` : "Drop or click to upload"}
            </div>
            <div style={{ fontSize:10, color:"#1e2a3b" }}>PDF · JPG · PNG · HEIC · max {MAX_FILES}</div>
            <input ref={fileRef} type="file" accept="application/pdf,image/*,.heic,.heif" multiple
              style={{ display:"none" }} onChange={e => addFiles(e.target.files)} />
          </div>

          {/* Slot dots */}
          <div style={{ padding:"0 12px 8px", display:"flex", gap:4 }}>
            {[0,1,2].map(i => (
              <div key={i} style={{ flex:1, height:3, borderRadius:2, background: i < queue.length ? "#38bdf8" : "#0d1a26", transition:"background 0.3s" }} />
            ))}
          </div>

          {/* Queue label */}
          {queue.length > 0 && (
            <div style={{ padding:"2px 12px 6px", fontSize:9, fontWeight:800, color:"#1e2a3b", letterSpacing:"0.1em", textTransform:"uppercase" }}>Queue</div>
          )}

          {/* Queue list */}
          <div style={{ flex:1, overflowY:"auto", padding:"0 8px" }}>
            {queue.length === 0 && (
              <div style={{ textAlign:"center", padding:"20px 8px", color:"#111c2a", fontSize:11 }}>No files yet</div>
            )}
            {queue.map((item, idx) => (
              <div key={item.id} className="qpill"
                onClick={() => { setEditSavedIdx(null); setEditSavedData(null); setReviewIdx(idx); }}
                style={{ padding:"9px 10px", borderRadius:9, marginBottom:5,
                  border:`1px solid ${reviewIdx === idx && !isSavedEdit ? "#38bdf8" : "#0d1520"}`,
                  background: reviewIdx === idx && !isSavedEdit ? "#0a1828" : "#080d17",
                  cursor: "pointer",
                  transition:"all 0.18s", opacity: item.status === "saved" ? 0.4 : 1,
                  position:"relative" }}>
                {reviewIdx === idx && !isSavedEdit && (
                  <div style={{ position:"absolute", left:0, top:0, bottom:0, width:3, background:"#38bdf8", borderRadius:"9px 0 0 9px" }} />
                )}
                <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:4 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:11, fontWeight:600, color:"#5a7a9a", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                      {item.fileType?.startsWith("image/") ? "🖼 " : "📄 "}{item.fileName}
                    </div>
                    <div style={{ marginTop:4 }}>
                      {item.status === "extracting"
                        ? <span style={{ fontSize:10, color:"#f59e0b", animation:"shimmer 1.2s infinite" }}>⟳ Extracting…</span>
                        : <StatusBadge status={item.status} />}
                    </div>
                    {item.status === "error" && item.errorMsg && (
                      <div style={{ marginTop:4, fontSize:9, color:"#ef4444bb", lineHeight:1.5, wordBreak:"break-word", maxHeight:70, overflowY:"auto", background:"#1a0808", borderRadius:4, padding:"4px 6px", border:"1px solid #ef444430" }}>
                        {item.errorMsg}
                      </div>
                    )}
                    {item.status === "error" && (
                      <button onClick={e => { e.stopPropagation(); retryExtract(item); }}
                        style={{ marginTop:4, background:"none", border:"1px solid #ef444444", color:"#ef4444aa", padding:"2px 8px", borderRadius:5, cursor:"pointer", fontSize:9, fontWeight:700, transition:"all 0.15s" }}
                        onMouseOver={e => { e.currentTarget.style.borderColor="#ef4444"; e.currentTarget.style.color="#ef4444"; }}
                        onMouseOut={e => { e.currentTarget.style.borderColor="#ef444444"; e.currentTarget.style.color="#ef4444aa"; }}>
                        ↻ Retry
                      </button>
                    )}
                    {item.lineItems?.length > 0 && item.status !== "pending" && (
                      <div style={{ marginTop:3 }}><Badge color="#38bdf8">{item.lineItems.length} items</Badge></div>
                    )}
                  </div>
                  <button onClick={e => { e.stopPropagation(); removeQueue(idx); }}
                    style={{ background:"none", border:"none", color:"#111c2a", cursor:"pointer", fontSize:13, padding:"1px 4px", transition:"color 0.15s" }}
                    onMouseOver={e => e.target.style.color="#ef4444"} onMouseOut={e => e.target.style.color="#111c2a"}>✕</button>
                </div>
              </div>
            ))}
          </div>

          {/* Saved list */}
          {saved.length > 0 && (
            <div style={{ borderTop:"1px solid #0d1520", padding:"8px", maxHeight:220, overflowY:"auto" }}>
              <div style={{ fontSize:9, fontWeight:800, color:"#1e2a3b", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6, paddingLeft:4 }}>
                Saved ({saved.length}) — click to edit
              </div>
              {saved.map((s, i) => (
                <div key={i} className="spill" onClick={() => openSavedForEdit(i)}
                  style={{ padding:"8px 10px", borderRadius:9, marginBottom:4,
                    border:`1px solid ${editSavedIdx === i ? "#f59e0b" : "#0d1520"}`,
                    background: editSavedIdx === i ? "#120d00" : "#080d17",
                    transition:"all 0.18s", position:"relative" }}>
                  {editSavedIdx === i && (
                    <div style={{ position:"absolute", left:0, top:0, bottom:0, width:3, background:"#f59e0b", borderRadius:"9px 0 0 9px" }} />
                  )}
                  <div style={{ fontSize:11, fontWeight:600, color: editSavedIdx === i ? "#f59e0b" : "#4a6a6a", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                    ✓ {s.form.invoiceNo || s.form.vendorName || s.fileName}
                  </div>
                  <div style={{ marginTop:3, display:"flex", gap:5, alignItems:"center", flexWrap:"wrap" }}>
                    {s.form.amount && <span style={{ fontSize:10, color:"#2a5050" }}>{s.form.currency} {s.form.amount}</span>}
                    {s.lineItems?.length > 0 && <Badge color="#0ea5e9">{s.lineItems.length} items</Badge>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Center: Review Form */}
        <div style={{ flex:1, minWidth:0, overflowY:"auto", padding:22 }}>
          {!reviewing ? (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", color:"#0d1a26", gap:10, textAlign:"center" }}>
              <div style={{ fontSize:52 }}>📋</div>
              <div style={{ fontSize:15, fontWeight:800, color:"#1a2a3a" }}>Select a file to review</div>
              <div style={{ fontSize:12, maxWidth:260 }}>Upload invoices and click from the queue to review, or click a saved invoice to re-edit</div>
            </div>
          ) : reviewing.status === "extracting" ? (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:14, textAlign:"center" }}>
              <div style={{ fontSize:36, animation:"shimmer 1.2s infinite" }}>⟳</div>
              <div style={{ fontSize:15, fontWeight:800, color:"#4a7499" }}>Extracting invoice data…</div>
              <div style={{ fontSize:12, color:"#334155", maxWidth:260 }}>AI is reading the invoice. Fields will populate automatically when done.</div>
              <div style={{ fontSize:11, color:"#1e2a3b" }}>{reviewing.fileName}</div>
            </div>
          ) : (
            <ReviewForm
              data={reviewing}
              onChangeForm={isSavedEdit ? updateSavedForm  : updateQueueForm}
              onChangeLines={isSavedEdit ? updateSavedLines : updateQueueLines}
              onSave={isSavedEdit ? updateSaved : saveQueue}
              onDiscard={isSavedEdit ? cancelSavedEdit : () => removeQueue(reviewIdx)}
              onAddMore={() => fileRef.current.click()}
              isSavedEdit={isSavedEdit}
            />
          )}
        </div>

        {/* Right: Preview — always mounted so no layout shift */}
        <div style={{ width:320, flexShrink:0, borderLeft:"1px solid #0d1520", overflow:"hidden", display:"flex", flexDirection:"column", background:"#07090f" }}>
          <InvoicePreview item={previewItem} />
        </div>
      </div>

      {/* Saved Table */}
      {saved.length > 0 && (
        <div style={{ borderTop:"1px solid #0d1520", padding:"16px 24px", background:"#04070e" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
            <div style={{ fontSize:13, fontWeight:800, letterSpacing:"-0.02em" }}>Saved Invoices</div>
            <button className="abtn" onClick={() => exportExcel(saved)}
              style={{ background:"linear-gradient(135deg,#0ea5e9,#0284c7)", border:"none", color:"#fff", padding:"6px 14px", borderRadius:7, cursor:"pointer", fontSize:11, fontWeight:700, transition:"all 0.18s" }}>
              ↓ Download Excel ({saved.length})
            </button>
          </div>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
              <thead>
                <tr style={{ borderBottom:"1px solid #0d1520" }}>
                  {["Invoice No.","Vendor Name","Vendor Addr.","Bill To","Bill To Addr.","Date","Due","Amount","Currency","Terms","Line Items"].map(h => (
                    <th key={h} style={{ padding:"6px 10px", textAlign:"left", fontSize:9, fontWeight:700, color:"#1e2a3b", letterSpacing:"0.08em", textTransform:"uppercase", whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {saved.map((inv, i) => (
                  <tr key={i} onClick={() => openSavedForEdit(i)}
                    style={{ borderBottom:"1px solid #090e18", cursor:"pointer" }}
                    onMouseOver={e => e.currentTarget.style.background="#0a0f1c"}
                    onMouseOut={e => e.currentTarget.style.background="transparent"}>
                    <td style={{ padding:"7px 10px", fontFamily:"'JetBrains Mono',monospace", color:"#38bdf8", whiteSpace:"nowrap" }}>{inv.form.invoiceNo||"—"}</td>
                    <td style={{ padding:"7px 10px", fontWeight:600, whiteSpace:"nowrap" }}>{inv.form.vendorName||"—"}</td>
                    <td style={{ padding:"7px 10px", color:"#334155", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{inv.form.vendorAddress||"—"}</td>
                    <td style={{ padding:"7px 10px", color:"#64748b", whiteSpace:"nowrap" }}>{inv.form.billToName||"—"}</td>
                    <td style={{ padding:"7px 10px", color:"#334155", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{inv.form.billToAddress||"—"}</td>
                    <td style={{ padding:"7px 10px", color:"#475569", whiteSpace:"nowrap" }}>{inv.form.invoiceDate||"—"}</td>
                    <td style={{ padding:"7px 10px", color: inv.form.dueDate ? "#f87171" : "#334155", whiteSpace:"nowrap" }}>{inv.form.dueDate||"—"}</td>
                    <td style={{ padding:"7px 10px", fontFamily:"'JetBrains Mono',monospace", fontWeight:600 }}>{inv.form.amount||"—"}</td>
                    <td style={{ padding:"7px 10px", color:"#475569" }}>{inv.form.currency||"—"}</td>
                    <td style={{ padding:"7px 10px", color:"#475569" }}>{inv.form.paymentTerms||"—"}</td>
                    <td style={{ padding:"7px 10px" }}>
                      {inv.lineItems?.length > 0 ? <Badge color="#38bdf8">{inv.lineItems.length} items</Badge> : <span style={{ color:"#1e2a3b" }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
