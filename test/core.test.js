import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitle, renderVtt } from '../src/core.js';

test('parses SRT and converts timestamps to WebVTT', () => {
  const srt = '1\n00:00:01,500 --> 00:00:03,000\nHello!\n\n2\n00:00:04,000 --> 00:00:06,250\n<i>How are you?</i>';
  const cues = parseSubtitle(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].timing, '00:00:01.500 --> 00:00:03.000');
  assert.equal(cues[1].text, '<i>How are you?</i>');
});

test('preserves WebVTT cue settings', () => {
  const input = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start position:0%\nHello\nworld';
  const cues = parseSubtitle(input);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].timing, '00:00:01.000 --> 00:00:02.000 align:start position:0%');
  assert.equal(cues[0].text, 'Hello\nworld');
});

test('renders a valid WebVTT header', () => {
  const out = renderVtt([
    { timing: '00:00:01.000 --> 00:00:02.000', text: 'Bonjour' }
  ]);
  assert.match(out, /^WEBVTT\n\n/);
  assert.match(out, /Bonjour/);
});
