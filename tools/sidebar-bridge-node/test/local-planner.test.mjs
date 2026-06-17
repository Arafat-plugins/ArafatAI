import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildLocalAgentReply } from '../src/local-planner.mjs';

function parseReply(body, options = {}) {
  const reply = buildLocalAgentReply(body, options);
  assert.notEqual(reply, null);
  return JSON.parse(reply);
}

test('opens YouTube homepage without Python/Codex', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'youtube a jao',
    page: { url: 'chrome://newtab/', title: 'New Tab' },
  }, { allowQuestionFallback: false });

  assert.equal(data.actions[0].type, 'navigate');
  assert.equal(data.actions[0].target, 'https://www.youtube.com/');
});

test('routes YouTube play goal to YouTube search, not unrelated current page links', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'goto youtube and play nora fateh fifa new video',
    page: {
      url: 'https://directorist.com/pricing/',
      title: 'Directorist Pricing',
      clickables: [
        { ref: 'ref_10', text: 'FormGent', href: 'https://www.formgent.com/' },
        { ref: 'ref_11', text: 'Pricing', href: 'https://directorist.com/pricing/' },
      ],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.done, false);
  assert.equal(data.actions[0].type, 'navigate');
  assert.match(data.actions[0].target, /^https:\/\/www\.youtube\.com\/results\?/);
  assert.match(data.actions[0].target, /nora\+fateh\+fifa\+new/);
  assert.doesNotMatch(data.actions[0].target.toLowerCase(), /formgent/);
});

test('waits on YouTube results until a watch link is visible', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'goto youtube and play nora fateh fifa new video',
    page: {
      url: 'https://www.youtube.com/results?search_query=nora+fateh+fifa+new',
      title: 'nora fateh fifa new - YouTube',
      clickables: [],
    },
    task_state: { observations: [] },
  }, { allowQuestionFallback: false });

  assert.equal(data.done, false);
  assert.equal(data.actions[0].type, 'wait');
  assert.equal(data.actions[0].target, 'youtube-results');
});

test('opens YouTube watch href instead of clicking a stale ref', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'goto youtube and play nora fateh fifa new video',
    page: {
      url: 'https://www.youtube.com/results?search_query=nora+fateh+fifa+new',
      title: 'nora fateh fifa new - YouTube',
      clickables: [
        {
          ref: 'ref_627',
          text: 'Nora Fatehi FIFA Fan Festival official video',
          href: 'https://www.youtube.com/watch?v=abc123',
        },
      ],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.done, false);
  assert.equal(data.actions[0].type, 'navigate');
  assert.equal(data.actions[0].target, 'https://www.youtube.com/watch?v=abc123');
});

test('researches YouTube when current watch page does not match song request', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'i told you play nora fateh songs',
    page: {
      url: 'https://www.youtube.com/watch?v=unrelated',
      title: 'Unrelated video - YouTube',
      visible_text: 'Unrelated video',
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.done, false);
  assert.equal(data.actions[0].type, 'navigate');
  assert.match(data.actions[0].target, /nora\+fateh\+songs/);
});

test('clicks visible YouTube skip ad button', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'skip the add',
    page: {
      url: 'https://www.youtube.com/watch?v=abc123',
      title: 'YouTube',
      clickables: [{ ref: 'ref_9', text: 'Skip Ad', selector: '.ytp-ad-skip-button' }],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.done, false);
  assert.equal(data.actions[0].type, 'click');
  assert.equal(data.actions[0].target, 'text=Skip Ad');
});

test('answers current site directly', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'tumi ekhon kon site e acho jano',
    page: {
      url: 'https://directorist.com/pricing/',
      title: 'Directorist Pricing - Choose the Best Plan - Save Up to 35%',
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.done, true);
  assert.equal(data.actions.length, 0);
  assert.match(data.reply, /directorist\.com/);
  assert.match(data.reply, /https:\/\/directorist\.com\/pricing\//);
});

test('opens theme tab before answering theme list from pricing page', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'navbare theme tab ache oitate click kore theme gular ekta list kore dao amake',
    page: {
      url: 'https://directorist.com/pricing/',
      title: 'Directorist Pricing - Choose the Best Plan - Save Up to 35%',
      visible_text: 'Pricing plans Annual Lifetime 1 Site Starter $129 Save 20% $103 /Year',
      clickables: [
        { ref: 'ref_4', text: 'Extensions', href: 'https://directorist.com/extensions/' },
        { ref: 'ref_5', text: 'Themes', href: 'https://directorist.com/themes/' },
        { ref: 'ref_8', text: 'Pricing', href: 'https://directorist.com/pricing/' },
      ],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.done, false);
  assert.equal(data.actions[0].type, 'navigate');
  assert.equal(data.actions[0].target, 'https://directorist.com/themes/');
});

test('lists themes after theme page is open', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'navbare theme tab ache oitate click kore theme gular ekta list kore dao amake',
    page: {
      url: 'https://directorist.com/themes/',
      title: 'WordPress Directory Theme Collection for Directories',
      visible_text: 'dHotels New $69 The Best Hotel Directory WordPress Theme Live Preview Details OneListing Minimal WordPress Directory Theme (Free) Live Preview Details OneListing Pro $69 WordPress Theme for Business Directory (Premium) Live Preview Details dService $69 Best Service WordPress Directory Theme Live Preview Details',
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.done, true);
  assert.equal(data.actions.length, 0);
  assert.match(data.reply, /dHotels - \$69/);
  assert.match(data.reply, /OneListing - Free/);
  assert.match(data.reply, /OneListing Pro - \$69/);
  assert.match(data.reply, /dService - \$69/);
});

test('unknown goals can defer when requested', () => {
  const reply = buildLocalAgentReply({
    mode: 'agent_task',
    goal: 'set up my whole n8n workflow',
    page: { url: 'https://n8n.io', title: 'n8n' },
  }, { allowQuestionFallback: false });

  assert.equal(reply, null);
});
