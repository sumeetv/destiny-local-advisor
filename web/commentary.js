const $ = (id) => document.getElementById(id);
let status = null, context = null, busy = false, previewVersion = 0;
function node(tag, text) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; }
function clear() {
  previewVersion++;
  context = null; $("allow-cloud").checked = false;
  $("facts").replaceChildren(); $("limitations").replaceChildren(); $("commentary").replaceChildren();
  $("notice").textContent = ""; $("generate").disabled = true;
}
function generationState() {
  $("generate").disabled = busy || !context || !status?.configured || status.provider === "none" || (status.sendsToCloud && !$("allow-cloud").checked);
}
function targets() {
  const scope = $("scope").value;
  const choices = scope === "build" ? status?.builds ?? [] : scope === "cleanup" ? status?.items ?? [] : [];
  $("target-label").hidden = !["build", "cleanup"].includes(scope);
  $("target").replaceChildren(...choices.map((item) => { const option = node("option", `${item.name}${item.classification ? ` · ${item.classification}` : ""}`); option.value = item.id; return option; }));
  clear();
}
function request() {
  const scope = $("scope").value;
  return { scope, ...(["build", "cleanup"].includes(scope) ? { target: $("target").value } : {}) };
}
async function preview() {
  clear(); $("error").hidden = true;
  const version = previewVersion;
  try {
    const data = request(), query = new URLSearchParams(data);
    const response = await fetch(`/api/commentary?${query}`), result = await response.json();
    if (version !== previewVersion) return;
    if (!response.ok) throw new Error(result.error ?? "Cannot load facts.");
    context = result;
    $("title").textContent = result.title;
    $("facts").replaceChildren(...result.facts.map((fact) => node("li", `${fact.id}: ${fact.text}`)));
    $("limitations").replaceChildren(...result.limitations.map((value) => node("li", value)));
    $("notice").textContent = "Facts loaded. Generation is optional.";
  } catch (error) { if (version !== previewVersion) return; $("error").textContent = error.message; $("error").hidden = false; }
  generationState();
}
async function generate() {
  if ($("generate").disabled || !context) return;
  busy = true; generationState(); $("preview").disabled = true; $("scope").disabled = true; $("target").disabled = true;
  $("commentary").replaceChildren(); $("notice").textContent = "Generating explanation…"; $("error").hidden = true;
  try {
    const response = await fetch("/api/commentary", { method: "POST", headers: { "Content-Type": "application/json", "X-Local-Request": "1" },
      body: JSON.stringify({ ...request(), revision: context.revision, allowCloud: $("allow-cloud").checked }) });
    const report = await response.json();
    if (!response.ok) throw new Error(report.error ?? "Commentary unavailable.");
    $("notice").textContent = `${report.status}: ${report.notice}`;
    $("commentary").replaceChildren(...report.paragraphs.map((paragraph) => node("p", `${paragraph.text} [${paragraph.factIds.join(", ")}]`)));
  } catch (error) {
    clear(); $("error").textContent = error.message; $("error").hidden = false;
    $("notice").textContent = "Commentary unavailable. Preview current facts before trying again.";
  } finally {
    busy = false; $("allow-cloud").checked = false; $("preview").disabled = false; $("scope").disabled = false; $("target").disabled = false; generationState();
  }
}
$("controls").addEventListener("submit", (event) => { event.preventDefault(); if (!busy) preview(); });
$("scope").addEventListener("change", targets);
$("target").addEventListener("change", clear);
$("allow-cloud").addEventListener("change", generationState);
$("generate").addEventListener("click", generate);
async function load() {
  try {
    const response = await fetch("/api/commentary/status"), result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Cannot load advisor configuration.");
    status = result;
    $("status").textContent = `${result.notice}${!result.configured ? " Set the model and provider settings in .env.local; see README." : ""}`;
    $("cloud-label").hidden = !result.sendsToCloud;
    targets(); await preview();
  } catch (error) { clear(); $("error").textContent = error.message; $("error").hidden = false; $("status").textContent = "Advisor unavailable. Deterministic screens remain available."; }
}
load();
