import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

assert.equal(manifest.version, '0.9.16');
assert.match(source, /const EXTENSION_VERSION = '0.9.16'/);
assert.match(source, /function validateGodlogCandidate/);
assert.match(source, /function buildGodlogCorrectionPrompt/);
assert.match(source, /function extractSecondaryResponseText/);
assert.match(source, /已自动纠正重试1次/);
assert.match(source, /callSummaryWriter\(correctionPrompt, 1800\)/);
assert.doesNotMatch(source, /body\.trim\(\)\.length < 30/);

const fields = ['Nub', 'Title', 'Time', 'Pln', 'Per', 'Cond'];
const compactCharacterCount = text => Array.from(String(text || '').replace(/\s+/g, '')).length;
const expectedMin = sourceChars => sourceChars >= 400 ? 200 : sourceChars >= 240 ? 150 : Math.max(60, Math.min(130, Math.floor(sourceChars * 0.62) || 60));
function normalize(body) {
  const raw = String(body || '').trim();
  if (!raw) return '';
  const text = raw.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  return text.match(/<Godlog>[\s\S]*?<\/Godlog>/i)?.[0] || `<Godlog>\n${text}\n</Godlog>`;
}
function validate(body, sourceChars) {
  const block = normalize(body);
  if (!block) return false;
  if (fields.some(tag => !new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i').test(block))) return false;
  const cond = block.match(/<Cond>([\s\S]*?)<\/Cond>/i)?.[1] || '';
  return compactCharacterCount(cond) >= expectedMin(sourceChars);
}
const longCond = '已'.repeat(205);
const shortCond = '已'.repeat(80);
const complete = cond => `<Godlog><Nub>1</Nub><Title>测试事件标题</Title><Time>未明</Time><Pln>未明</Pln><Per>甲</Per><Cond>${cond}</Cond></Godlog>`;
assert.equal(validate(complete(longCond), 800), true);
assert.equal(validate(complete(shortCond), 800), false);
assert.equal(validate(complete('已'.repeat(70)), 100), true, 'short source uses a proportional floor');
assert.equal(validate('&lt;Godlog&gt;&lt;Nub&gt;1&lt;/Nub&gt;&lt;Title&gt;测试事件标题&lt;/Title&gt;&lt;Time&gt;未明&lt;/Time&gt;&lt;Pln&gt;未明&lt;/Pln&gt;&lt;Per&gt;甲&lt;/Per&gt;&lt;Cond&gt;' + longCond + '&lt;/Cond&gt;&lt;/Godlog&gt;', 800), true);
assert.equal(validate('<Godlog><Nub>1</Nub><Cond>' + longCond + '</Cond></Godlog>', 800), false, 'missing fields are rejected');

function textValue(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : typeof part?.content === 'string' ? part.content : '').filter(Boolean).join('').trim();
  return '';
}
assert.equal(textValue([{ type: 'text', text: '<Godlog>' }, { type: 'text', text: '</Godlog>' }]), '<Godlog></Godlog>');
assert.equal(textValue('  abc  '), 'abc');

console.log('Anchor Memory 0.9.13 summary validation tests passed.');
