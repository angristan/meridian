export const SETUP_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Set up Meridian</title>
  <style>
    :root{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5;color-scheme:light dark}
    body{margin:0;padding:2rem 1rem;background:Canvas;color:CanvasText}
    main{max-width:38rem;margin:8vh auto;padding:1.5rem;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:1rem}
    h1{margin-top:0} label{display:block;font-weight:650;margin-bottom:.4rem}
    input,button{box-sizing:border-box;font:inherit;border-radius:.5rem;padding:.7rem}
    input{width:100%;border:1px solid color-mix(in srgb,CanvasText 35%,transparent)}
    button,.button{display:inline-block;margin-top:1rem;border:0;background:#6657d9;color:white;text-decoration:none;cursor:pointer}
    .button{padding:.7rem;border-radius:.5rem} #result[hidden]{display:none}
    code{display:block;overflow-wrap:anywhere;padding:.8rem;background:color-mix(in srgb,CanvasText 8%,transparent);border-radius:.5rem}
    .error{color:#c33} small{opacity:.8}
  </style>
</head>
<body><main>
  <h1>Connect Meridian</h1>
  <p>Enter the one-time setup token chosen during deployment. It is exchanged for a short-lived claim session and is never placed in the Obsidian link.</p>
  <form id="setup-form">
    <label for="token">Setup token</label>
    <input id="token" name="token" type="password" autocomplete="off" minlength="32" required autofocus>
    <button type="submit">Create setup session</button>
  </form>
  <p id="status" role="status" aria-live="polite"></p>
  <section id="result" hidden>
    <h2>Continue in Obsidian</h2>
    <p><a class="button" id="open-link" href="#">Open in Obsidian</a></p>
    <p><small>If the link does not open, copy it into your browser on the device running Obsidian.</small></p>
    <code id="copy-value"></code>
    <button id="copy-button" type="button">Copy setup link</button>
  </section>
</main><script src="/assets/setup.js" defer></script></body></html>`

export const SETUP_SCRIPT = `"use strict";
const form=document.querySelector("#setup-form");
const token=document.querySelector("#token");
const status=document.querySelector("#status");
const result=document.querySelector("#result");
const openLink=document.querySelector("#open-link");
const copyValue=document.querySelector("#copy-value");
const copyButton=document.querySelector("#copy-button");
let setupLink="";
form.addEventListener("submit",async(event)=>{
  event.preventDefault(); status.className=""; status.textContent="Creating a short-lived session…"; result.hidden=true;
  try {
    const response=await fetch("/v1/setup/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:token.value})});
    token.value="";
    const payload=await response.json();
    if(!response.ok) throw new Error(payload?.error?.message||"Setup failed");
    const query=new URLSearchParams({endpoint:location.origin,session:payload.setupSession,challenge:payload.claimChallenge});
    setupLink="obsidian://meridian?"+query.toString();
    openLink.href=setupLink; copyValue.textContent=setupLink; result.hidden=false;
    status.textContent="Session created. It expires soon and can claim this deployment only once.";
  } catch(error) { status.className="error"; status.textContent=error instanceof Error?error.message:"Setup failed"; }
});
copyButton.addEventListener("click",async()=>{if(!setupLink)return;await navigator.clipboard.writeText(setupLink);status.textContent="Setup link copied.";});`

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
}
