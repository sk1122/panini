// Use native event time. Never use receipt time or an inherited Git author date.
export function normalizeSourceTime(event, nativeTimes) {
 let occurredAt=event.occurredAt;
 if(event.provider==='github' && event.eventKind==='commit.snapshot') {
  const proof=nativeTimes?.times?.[event.payload.sha];
  occurredAt=proof?.committedAt ?? event.payload.committedAt;
  if(!occurredAt)throw Error(`Missing native commit creation time: ${event.id}`);
 } else if(event.provider==='slack' && event.payload.messageTs) {
  occurredAt=new Date(Number(event.payload.messageTs)*1000).toISOString();
 }
 if(!Number.isFinite(Date.parse(occurredAt)))throw Error(`Invalid native source time: ${event.id}`);
 return {...event,occurredAt:new Date(occurredAt).toISOString()};
}

export function nativeSourceTimestamp(event) {
 return event.eventKind==='branch.snapshot'?null:Date.parse(event.occurredAt);
}
export function compareNativeSourceEvents(a,b) {
 const left=nativeSourceTimestamp(a),right=nativeSourceTimestamp(b);
 return left===null&&right===null?a.id.localeCompare(b.id):left===null?1:right===null?-1:left-right||a.id.localeCompare(b.id);
}
