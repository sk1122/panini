type AuthPage = "login" | "setup" | "join" | "reset-password";
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function renderAuthPage(page: AuthPage, nonce: string, next: string, githubEnabled = false): string {
  const setup = page === "setup";
  const join = page === "join";
  const reset = page === "reset-password";
  const title = setup ? "Create your workspace" : join ? "Join your company" : reset ? "Choose a new password" : "Welcome back";
  const subtitle = setup ? "Set up your company and your personal owner account." : join ? "Your invitation gives you access to your company's shared work and knowledge."
    : reset ? "This will sign out your existing sessions." : "Sign in to your company's workspace.";
  const action = setup ? "Create workspace" : join ? "Join workspace" : reset ? "Reset password" : "Sign in";
  const safeNonce = escapeHtml(nonce);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title} | Panini</title><link rel="icon" href="/assets/panini-mark.svg?v=pa" type="image/svg+xml"><style nonce="${safeNonce}">
*{box-sizing:border-box}body{margin:0;color:#1f2933;background:#f5f6f7;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:#315f88;text-underline-offset:3px}header{padding:24px 32px}header a{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:inherit;font-weight:750;font-size:17px}.mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#315f88;color:white;font-size:23px;box-shadow:inset 0 -3px #e13e24}.auth-shell{max-width:450px;margin:24px auto 70px;padding:30px;background:white;border:1px solid #dde2e6;border-radius:14px}.eyebrow{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#647586}h1{font-size:28px;line-height:1.2;letter-spacing:-.035em;margin:10px 0}p{color:#586774;margin:0 0 23px}form{display:grid;gap:16px}.field{display:grid;gap:6px}label{font-size:12px;font-weight:650}input{width:100%;min-height:44px;border:1px solid #ccd4dc;border-radius:8px;padding:10px 12px;font:inherit;color:inherit;background:#fff}input:focus{outline:3px solid #c6d8e9;outline-offset:1px}small{font-size:11px;color:#687887}.submit{min-height:44px;border:0;border-radius:8px;background:#315f88;color:white;font:650 14px/1.4 inherit;cursor:pointer;padding:11px 16px}.submit:hover{background:#23496c}.submit:disabled{opacity:.6;cursor:wait}.error{padding:10px 12px;border:1px solid #e6b8b8;border-radius:8px;background:#fff4f4;color:#943636;margin:0}.success{padding:12px;background:#edf6ef;border:1px solid #bfd8c6;border-radius:8px;color:#2b6440}.footer{margin:22px 0 0;border-top:1px solid #e3e7eb;padding-top:18px;font-size:12px}details{margin-top:16px;font-size:12px;color:#586774}summary{cursor:pointer}details p{margin:8px 0 0}[hidden]{display:none!important}@media(max-width:520px){header{padding:22px}.auth-shell{margin:6px 16px 40px;padding:24px}h1{font-size:26px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body><header><a href="/" aria-label="Panini home"><span class="mark" lang="sa" aria-hidden="true">प</span>Panini</a></header><main class="auth-shell"><span class="eyebrow">${setup ? "Your company starts here" : "The grammar of work"}</span><h1>${title}</h1><p>${subtitle}</p>
<style nonce="${safeNonce}">#github-sign-in{width:100%;background:#24292f}#github-sign-in:hover{background:#101418}</style>
<p id="auth-error" class="error" role="alert" hidden></p><div id="auth-success" class="success" role="status" hidden></div>
<form id="auth-form">
${setup ? '<div class="field"><label for="installation-secret">Installation secret</label><input id="installation-secret" name="token" type="password" autocomplete="off" required maxlength="500"><small>Use APP_ADMIN_TOKEN from your installation environment file.</small></div><div class="field"><label for="company-name">Company name</label><input id="company-name" name="companyName" autocomplete="organization" required maxlength="120"></div>' : ''}
${setup || join ? '<div class="field"><label for="display-name">Your name</label><input id="display-name" name="displayName" autocomplete="name" required maxlength="120"></div>' : ''}
${!join && !reset ? '<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="254"></div>' : ''}
<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${page === 'login' ? 'current-password' : 'new-password'}" required minlength="${page === 'login' ? '1' : '15'}" maxlength="128">${page === 'login' ? '' : '<small>At least 15 characters. A few memorable words work well.</small>'}</div>
<button class="submit" type="submit">${action}</button></form>
${githubEnabled && !reset ? `<div class="footer"><button class="submit" id="github-sign-in" type="button">${setup ? "Create workspace with GitHub" : join ? "Join with GitHub" : "Sign in with GitHub"}</button>${setup ? '<small>Fill in the installation secret, company, name and email above. No password is needed for GitHub.</small>' : join ? '<small>Your invitation gives access to the GitHub account you choose.</small>' : ''}</div>` : ''}
${page === 'login' ? '<details><summary>Forgot your password?</summary><p>Ask a workspace administrator for a password reset link. If you are the only owner, your server operator can create one using the recovery command in the self-hosting guide.</p></details>' : '<p class="footer">Already have an account? <a href="/login">Sign in</a></p>'}
</main><script nonce="${safeNonce}">
const page=${JSON.stringify(page)};
const next=${JSON.stringify(next)};
const linkToken=window.location.hash.slice(1);
if(linkToken)window.history.replaceState(null,'',window.location.pathname+window.location.search);
const form=document.getElementById('auth-form');
const error=document.getElementById('auth-error');
const submit=form.querySelector('button[type="submit"]');
const githubError=new URLSearchParams(window.location.search).get('githubError');
if(githubError){error.textContent=githubError==='not_linked'?'This GitHub account is not connected. Sign in with your password and connect GitHub in Settings, or open your invitation.':'GitHub sign-in could not be completed. It may have expired, been cancelled, or used a different browser. Start again; for an invitation, reopen the original link.';error.hidden=false;window.history.replaceState(null,'',window.location.pathname);}
if((page==='join'||page==='reset-password')&&!linkToken){error.textContent='Open the full link supplied by your administrator, including the part after #.';error.hidden=false;submit.disabled=true;}
form.addEventListener('submit',async(event)=>{
  event.preventDefault();error.hidden=true;submit.disabled=true;
  const original=submit.textContent;submit.textContent='Please wait…';
  try{
    const body=Object.fromEntries(new FormData(form));
    if(page==='join'||page==='reset-password')body.token=linkToken;
    const endpoint=({login:'login',setup:'bootstrap',join:'invitations/accept','reset-password':'reset-password'})[page];
    const response=await fetch('/api/auth/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Unable to continue. Please try again.');
    form.reset();
    if(page==='reset-password'){
      form.hidden=true;const success=document.getElementById('auth-success');success.textContent='Password changed. You can now sign in with your new password.';success.hidden=false;
    }else{window.location.assign(result.onboarding?.completedAt?next:'/app/onboarding');}
  }catch(failure){error.textContent=failure.message||'Unable to reach Panini. Try again.';error.hidden=false;}
  finally{submit.disabled=false;submit.textContent=original;}
});
document.getElementById('github-sign-in')?.addEventListener('click',async(event)=>{
  const button=event.currentTarget;error.hidden=true;
  const values=Object.fromEntries(new FormData(form));
  const required=page==='setup'?['token','companyName','displayName','email']:page==='join'?['displayName']:[];
  for(const name of required){if(!form.elements.namedItem(name).reportValidity())return;}
  if(page==='join'&&!linkToken){error.textContent='Reopen the invitation supplied by your administrator.';error.hidden=false;return;}
  button.disabled=true;
  try{
    const body=page==='setup'?{purpose:'setup',token:values.token,companyName:values.companyName,displayName:values.displayName,email:values.email}:page==='join'?{purpose:'join',token:linkToken,displayName:values.displayName}:{purpose:'login',next};
    const response=await fetch('/api/auth/github/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to start GitHub sign-in.');
    window.location.assign(result.authorizationUrl);
  }catch(failure){error.textContent=failure.message||'Unable to reach GitHub.';error.hidden=false;button.disabled=false;}
});
</script></body></html>`;
}
