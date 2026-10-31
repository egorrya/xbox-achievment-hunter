// A restored queue belongs to one Xbox account and is never shown before that account is verified.
export function queueView(state, {external=false, status='signed_out', autoStatus='idle', xuid}={}) {
  if(external && !xuid)return state;
  if((!external && status!=='signed_in')||autoStatus==='connecting'||!/^\d+$/.test(String(xuid||'')))return {status:'idle'};
  if(state.status==='idle')return {status:'idle'};
  if(String(state.accountXuid||'')!==String(xuid))return {status:'idle',accountMismatch:true};
  return state;
}
export function connectionView(auth, autoAuth) {
  const status=autoAuth.needsReconnect?'signed_out':auth.status==='signed_in'&&autoAuth.status==='connecting'?'restoring':auth.status;
  return {...auth,status,autoAuth};
}
export function xboxRecoveryAction(error, {external=false, enabled=false, source}={}) {
  if (external || !enabled || source!=='xbox-pc') return 'none';
  if (error?.status===401) return 'reauthorize';
  return /No (?:usable )?Xbox PC authorization found/i.test(error?.message||'')?'retry':'none';
}

// A persisted spoof session is visible only to its original account.
export function spoofView(spoof, {status='signed_out', external=false, xuid}={}) {
  if ((!external && status!=='signed_in') || !/^\d+$/.test(String(xuid||'')) || String(spoof.accountXuid||'')!==String(xuid)) return {status:'idle'};
  const {accountXuid, ...view} = spoof;
  return view;
}
