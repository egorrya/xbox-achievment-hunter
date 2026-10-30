let version;
let checking = false;
async function checkVersion() {
  if (checking) return;
  checking = true;
  try {
    const response = await fetch('/api/dev/version', {cache:'no-store', signal:AbortSignal.timeout(3000)});
    if (!response.ok) return;
    const data = await response.json();
    if (version !== undefined && version !== data.version) { location.reload(); return; }
    version = data.version;
  } catch { /* Wait for the server to restart. */ }
  finally { checking = false; }
}
checkVersion();
setInterval(checkVersion, 1000);
