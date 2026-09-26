import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevClassifier } from '../dist/jev.js';
import { tagInputSchema } from '@onoff/contracts';
const id = '40000000-0000-4000-8000-000000000001';
const tags = [{ id, name: 'Devis', prompt: 'Le client demande un devis.', kind: 'call', aiEnabled: true }];
const response = (choice=id, confidence=.94, probabilities={ [id]: .98, none: .02 }) => ({ model: 'jev-1.13.0', answers: { tag: { type: 'choice', choice, confidence, probabilities } } });
const classifier = (answer) => createJevClassifier('test-key', 'jev-1.13.0', async () => Response.json(answer));
test('Jev follows the official typed API, pins model and keeps credentials server-side', async () => {
 const classify = createJevClassifier('test-key', 'jev-1.13.0', async (url, request) => {
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'jev-1.13.0'); assert.equal(body.questions.tag.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.tag.criteria), [id, 'none']);
  assert.deepEqual(body.state, { transcript: 'Un devis SVP' });
  assert.ok(request.signal); return Response.json(response());
 });
 assert.deepEqual(await classify({ transcript: 'Un devis SVP' }, tags, .85), { tagId: id, confidence: .94, model: 'jev-1.13.0' });
});
test('low confidence, low probability and none abstain', async () => {
 for (const answer of [response(id,.7),response(id,.94,{[id]:.6,none:.4}),response('none',.99,{[id]:.01,none:.99})]) assert.equal((await classifier(answer)('text',tags,.85)).tagId,null);
});
test('unknown labels, malformed distributions and non-finite confidence fail closed', async () => {
 for (const answer of [response('invented'),response(id,.95,{[id]:1,none:1}),response(id,.95,{[id]:.1,none:.9}),response(id,2),response(id,.95,{[id]:1}),{},response(id,.95,{[id]:.96,other:.04})]) await assert.rejects(classifier(answer)('text',tags,.85),/invalide/);
});
test('provider failures never expose response body or API key', async () => {
 const classify=createJevClassifier('secret',undefined,async()=>new Response('private transcript',{status:429}));
 await assert.rejects(classify('text',tags,.85),/temporairement indisponible/);
});
test('oversized input is rejected without sending or truncating it', async () => {
 let called=false; const classify=createJevClassifier('secret',undefined,async()=>{called=true;return Response.json(response());});
 await assert.rejects(classify('x'.repeat(100001),tags,.85),/trop longs/); assert.equal(called,false);
});
test('AI tags require a real criterion; manual tags do not', () => {
 assert.equal(tagInputSchema.safeParse({name:'Devis',kind:'call',aiEnabled:true,prompt:''}).success,false);
 assert.equal(tagInputSchema.safeParse({name:'Devis',kind:'call'}).success,true);
 assert.equal(tagInputSchema.safeParse({name:' ',kind:'call'}).success,false);
});

test('contact tags are outside AI call tag scope', () => {
 assert.equal(tagInputSchema.safeParse({name:'Devis',kind:'contact'}).success,false);
});
