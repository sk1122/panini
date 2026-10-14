// Explicit retry authorization is saved only after the old call is reconciled.
// Keep the old receipt and checkpoint. Never change the inference request.
export function recoveryStore(store, recoveries) {
 const byKey=new Map(recoveries.map(r=>[r.originalLogicalCallKey,r]));
 const resolve=key=>{let recovery=null;const seen=new Set();while(byKey.has(key)){if(seen.has(key))throw Error('Recovery key cycle');seen.add(key);recovery=byKey.get(key);key=recovery.retryLogicalCallKey;}return {key,recovery};};
 return new Proxy(store,{get(target,property){
  if(property==='getModelCallResponseByKey')return key=>target.getModelCallResponseByKey(resolve(key).key);
  if(property==='reserveModelCall')return input=>{const {key,recovery}=resolve(input.logicalCallKey);if(recovery&&input.requestHash!==recovery.requestHash)throw Error('Recovery request changed');return target.reserveModelCall({...input,logicalCallKey:key});};
  const value=target[property];return typeof value==='function'?value.bind(target):value;
 }});
}
