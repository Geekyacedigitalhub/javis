"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import "./research.css";

type ResearchSource = {
  requestedUrl: string;
  url: string;
  host: string;
  title?: string;
  description?: string;
  contentType: string;
  excerpt: string;
  text: string;
  fetchedAt: string;
};

const API = "/api/frosh";
const MAX_SOURCES = 6;

export default function ResearchPage() {
  const [url, setUrl] = useState("");
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function fetchSource(event: FormEvent) {
    event.preventDefault();
    const requestedUrl = url.trim();
    if (!requestedUrl || busy) return;
    if (sources.length >= MAX_SOURCES) {
      setMessage(`A report can contain up to ${MAX_SOURCES} sources. Remove a source before adding another.`);
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${API}/v1/research/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: requestedUrl }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "FROSH could not retrieve that source.");
      const source = data.source as ResearchSource;
      setSources((current) => [source, ...current.filter((item) => item.url !== source.url)]);
      setUrl("");
      setMessage(`Source captured from ${source.host}. Review the extracted text before drawing conclusions.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "FROSH could not retrieve that source.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="research-page">
      <header className="research-header">
        <div>
          <Link href="/" className="back">← FROSH Command Center</Link>
          <div className="eyebrow">FROSH / RESEARCH</div>
          <h1>Research Desk</h1>
          <p>
            Collect readable text from public HTTPS sources, compare the evidence,
            and keep the original source links with your notes.
          </p>
        </div>
      </header>

      <form className="research-form" onSubmit={fetchSource}>
        <label htmlFor="research-url">Public HTTPS source URL</label>
        <div>
          <input
            id="research-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/article"
            disabled={busy}
            required
          />
          <button type="submit" disabled={busy || !url.trim()}>
            {busy ? "Reading…" : "Add source"}
          </button>
        </div>
        <small>FROSH refuses local/private addresses, non-HTTPS pages, large files, and unsafe redirects.</small>
      </form>

      {message && <div className="research-status" role="status">{message}</div>}

      {!sources.length ? (
        <section className="research-empty">
          <div>⌕</div>
          <h2>Start with a source</h2>
          <p>Paste a public article, documentation page, report, or text-based API response to create a research packet.</p>
        </section>
      ) : (
        <section className="research-results" aria-label="Research sources">
          <div className="research-summary">
            <strong>{sources.length} source{sources.length === 1 ? "" : "s"} collected</strong>
            <span>Cross-check claims; FROSH preserves the source instead of presenting extracted text as a verified conclusion.</span>
          </div>
          {sources.map((source) => (
            <article className="research-source" key={source.url}>
              <div className="research-source-head">
                <div>
                  <span className="research-host">{source.host}</span>
                  <h2>{source.title || source.host}</h2>
                  {source.description && <p>{source.description}</p>}
                </div>
                <button
                  className="research-remove"
                  onClick={() => setSources((current) => current.filter((item) => item.url !== source.url))}
                >
                  Remove
                </button>
              </div>
              <p className="research-excerpt">{source.excerpt || "No readable text was found on this page."}</p>
              <div className="research-meta">
                <a href={source.url} target="_blank" rel="noreferrer">Open original source ↗</a>
                <span>{source.contentType.split(";")[0]} · {new Date(source.fetchedAt).toLocaleString()}</span>
              </div>
              <details>
                <summary>Read extracted text</summary>
                <pre>{source.text || "No readable text was found."}</pre>
              </details>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
