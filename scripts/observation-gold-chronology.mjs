// Read-only export: source send/create/edit time defines sequence, never collection time.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {normalizeSourceTime,compareNativeSourceEvents,nativeSourceTimestamp} from './observation-source-time.mjs';
import {contentHash} from '../dist/src/domain/content-hash.js';
const input=path.resolve(process.argv[2]??'artifacts/observation-agent/gold-v2-20261004/source-packets.json');
const folder=path.resolve(process.argv[3]??'artifacts/observation-agent/final-chronology');
const packets=JSON.parse(await fs.readFile(input,'utf8')).packets;
const nativeTimes=JSON.parse(await fs.readFile(path.resolve(process.argv[4]??'artifacts/observation-agent/final-chronology/all-commit-times.json'),'utf8'));
assert(nativeTimes.selectedCommitsVerified,'Commit creation times not verified');
const events=new Map();
for(const p of packets){const e=normalizeSourceTime(p.event,nativeTimes);assert(Number.isFinite(Date.parse(e.occurredAt)),`Invalid timestamp ${e.id}`);const prior=events.get(e.id);if(prior)assert(prior.occurredAt===e.occurredAt);else events.set(e.id,e);}
const sentTime=e=>e.provider==="slack"&&e.payload.messageTs?Number(e.payload.messageTs)*1000:Date.parse(e.occurredAt);
const compare=compareNativeSourceEvents;
const ordered=[...events.values()].filter(e=>nativeSourceTimestamp(e)!==null).sort(compare);
const undatedMetadata=[...events.values()].filter(e=>nativeSourceTimestamp(e)===null).map(e=>({...e,nativeSourceTime:null,timestampBasis:"Capture-only branch reference; creation date unknown"}));
const slackChecks=ordered.filter(e=>e.provider==='slack'&&e.payload.messageTs).map(e=>({id:e.id,occurredAt:e.occurredAt,sentAt:new Date(Number(e.payload.messageTs)*1000).toISOString(),matches:Math.abs(Date.parse(e.occurredAt)-Number(e.payload.messageTs)*1000)<1}));
const timestampDifferences=slackChecks.filter(c=>!c.matches);
const perCaseOrderEquivalent=[...new Set(packets.map(p=>p.caseId))].every(id=>{const items=packets.filter(p=>p.caseId===id).map(p=>p.event);return JSON.stringify([...items].sort(compare).map(e=>e.id))===JSON.stringify([...items].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id)).map(e=>e.id));});
const changedCaseOrder=[...new Set(packets.map(p=>p.caseId))].filter(id=>{const items=packets.filter(p=>p.caseId===id).map(p=>p.event);return JSON.stringify(items.map(e=>events.get(e.id)).sort(compare).map(e=>e.id))!==JSON.stringify([...items].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id)).map(e=>e.id));});
const perCase=[...new Set(packets.map(p=>p.caseId))].map(id=>({id,events:packets.filter(p=>p.caseId===id).map(p=>events.get(p.event.id)).sort(compare).map(e=>({id:e.id,occurredAt:nativeSourceTimestamp(e)===null?null:e.occurredAt,timestampBasis:nativeSourceTimestamp(e)===null?"capture-only reference, creation unknown":"native"}))}));
const report={ok:true,eventCount:ordered.length,sourceEventCount:events.size,undatedMetadataCount:undatedMetadata.length,caseCount:perCase.length,first:ordered[0]?.occurredAt,last:ordered.at(-1)?.occurredAt,basis:'Slack send time; verified Git commit creation time (committer date); Notion source version edit time. Page creation time is retained separately, because later content must not be moved back to creation.',nativeTimesHash:contentHash(nativeTimes),collectionTimesUsed:false,changedCaseOrder,perCaseOrderEquivalent,timestampDifferences,tieBreak:'UUID only for equal source timestamps',slackChecks,perCase};
await fs.mkdir(folder,{recursive:true});await fs.writeFile(folder+'/verification.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});await fs.writeFile(folder+'/messages.json',JSON.stringify({order:report.basis,undatedMetadata,events:ordered.map(e=>({...e,originalSourceTime:new Date(sentTime(e)).toISOString()}))},null,2)+'\n',{mode:0o600});
const original=JSON.parse(await fs.readFile('artifacts/observation-agent/gold-v3-20261004/reviewed-gold-manifest.json','utf8'));
const cases=original.cases.map(c=>({...c,sourceEventIds:[...c.sourceEventIds].sort((a,b)=>compare(events.get(a),events.get(b)))}));
assert(cases.every((c,i)=>JSON.stringify(c.expectedOutcomes)===JSON.stringify(original.cases[i].expectedOutcomes)),'Chronology export changed expected outcomes');
await fs.writeFile(folder+'/reviewed-gold-manifest.json',JSON.stringify({...original,cases,frozenHash:contentHash(cases),chronologySourceHash:original.frozenHash,expectedOutcomesUnchanged:true,nativeTimesHash:contentHash(nativeTimes)},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({ok:true,eventCount:report.eventCount,caseCount:report.caseCount,first:report.first,last:report.last,folder}));
