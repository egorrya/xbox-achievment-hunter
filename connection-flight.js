// Share a pending connection attempt and allow a fresh attempt after either outcome.
export function singleFlight(run) {
  let pending;
  return (...args) => {
    if (pending) return pending;
    pending=Promise.resolve().then(()=>run(...args)).finally(()=>{pending=undefined;});
    return pending;
  };
}
