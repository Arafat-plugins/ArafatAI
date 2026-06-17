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

test('does not let old WP Reset memory hijack a new YouTube task', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'programming gio er ekta video play koro youtube theke',
    page: {
      url: 'https://cbo-bizhub.com/wp-admin/plugins.php',
      title: 'Plugins - WordPress',
      visible_text: 'Plugins WP Reset Deactivate',
      clickables: [],
    },
    conversation_memory: {
      summary: 'Previous task: WP Reset plugin active kore site reset korte hobe.',
      last_task: {
        goal: 'current page a plugin e dhuke wp reset plugin active koro then reset site',
        reply: 'WP Reset confirm field e "reset" type korchi.',
      },
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.actions[0].type, 'navigate');
  assert.match(data.actions[0].target, /^https:\/\/www\.youtube\.com\/results\?/);
  assert.match(data.actions[0].target, /programming\+gio/);
});

test('waits for manual verification on Google reCAPTCHA page', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'programming gio er ekta video play koro youtube theke',
    page: {
      url: 'https://www.google.com/sorry/index?continue=https://www.youtube.com/watch%3Fv%3D5Cgio2OfOYk',
      title: 'Google Sorry',
      visible_text: "I'm not a robot reCAPTCHA Our systems have detected unusual traffic from your computer network.",
      clickables: [{ ref: 'ref_1', text: "I'm not a robot", selector: '#recaptcha-anchor' }],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.actions.length, 1);
  assert.equal(data.actions[0].type, 'wait_for_manual_verification');
  assert.equal(data.actions[0].target, 'google-captcha');
  assert.equal(data.needs_approval, true);
  assert.match(data.reply, /automatically same task continue/i);
  assert.match(data.reasoning_summary.join(' '), /human verification/i);
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

test('does not repeat generic risky approval question after explicit local reset confirmation', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'ji eita local site eita reset korbo',
    page: {
      url: 'https://local.test/wp-admin/',
      title: 'Dashboard - WordPress',
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.questions.length, 0);
  assert.equal(data.actions[0].type, 'navigate');
  assert.equal(data.actions[0].target, 'https://local.test/wp-admin/plugins.php?s=wp+reset&plugin_status=all');
});

test('activates installed WP Reset plugin from plugins page', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'ji eita local site eita reset korbo',
    page: {
      url: 'https://local.test/wp-admin/plugins.php?s=wp+reset&plugin_status=all',
      title: 'Plugins - WordPress',
      visible_text: 'WP Reset Inactive Activate',
      clickables: [
        {
          ref: 'ref_10',
          text: 'Activate',
          href: 'https://local.test/wp-admin/plugins.php?action=activate&plugin=wp-reset%2Fwp-reset.php&_wpnonce=abc',
        },
      ],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.questions.length, 0);
  assert.equal(data.actions[0].type, 'navigate');
  assert.match(data.actions[0].target, /action=activate/);
  assert.match(data.actions[0].target, /wp-reset/);
});

test('opens WP Reset tool page after plugin is active', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'ji eita local site eita reset korbo',
    page: {
      url: 'https://local.test/wp-admin/plugins.php?s=wp+reset&plugin_status=all',
      title: 'Plugins - WordPress',
      visible_text: 'WP Reset Active Deactivate',
      clickables: [],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.actions[0].type, 'navigate');
  assert.equal(data.actions[0].target, 'https://local.test/wp-admin/tools.php?page=wp-reset');
});

test('continues WP Reset from memory for a short approval reply', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'ji',
    page: {
      url: 'https://local.test/wp-admin/tools.php?page=wp-reset',
      title: 'WP Reset - WordPress',
      visible_text: 'WP Reset Reset Site Type reset to confirm',
      forms: [
        {
          selector: '#wp-reset-form',
          fields: [
            {
              ref: 'ref_20',
              selector: '#wp-reset-confirm',
              name: 'wp-reset-confirm',
              type: 'text',
              placeholder: 'Type reset',
              value_length: 0,
            },
          ],
        },
      ],
      clickables: [{ ref: 'ref_21', text: 'Reset Site' }],
    },
    conversation_memory: {
      last_task: {
        goal: 'wp reset final page e achi, site reset korte hobe',
        reply: 'Confirm korben je ei site reset korte hobe?',
      },
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.actions[0].type, 'type');
  assert.equal(data.actions[0].target, 'ref_20');
});

test('types WP Reset confirmation keyword after approval', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'ji eita local site eita reset korbo',
    page: {
      url: 'https://local.test/wp-admin/tools.php?page=wp-reset',
      title: 'WP Reset - WordPress',
      visible_text: 'WP Reset Reset Site Type reset to confirm',
      forms: [
        {
          selector: '#wp-reset-form',
          fields: [
            {
              ref: 'ref_20',
              selector: '#wp-reset-confirm',
              name: 'wp-reset-confirm',
              type: 'text',
              placeholder: 'Type reset',
              value_length: 0,
            },
          ],
        },
      ],
      clickables: [{ ref: 'ref_21', text: 'Reset Site' }],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.actions[0].type, 'type');
  assert.equal(data.actions[0].target, 'ref_20');
  assert.equal(data.actions[0].value, 'reset');
});

test('clicks final WP Reset button after confirmation field is filled', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'ji eita local site eita reset korbo',
    page: {
      url: 'https://local.test/wp-admin/tools.php?page=wp-reset',
      title: 'WP Reset - WordPress',
      visible_text: 'WP Reset Reset Site Type reset to confirm',
      forms: [
        {
          selector: '#wp-reset-form',
          fields: [
            {
              ref: 'ref_20',
              selector: '#wp-reset-confirm',
              name: 'wp-reset-confirm',
              type: 'text',
              placeholder: 'Type reset',
              value_length: 5,
            },
          ],
        },
      ],
      clickables: [{ ref: 'ref_21', text: 'Reset Site' }],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.actions[0].type, 'click');
  assert.equal(data.actions[0].target, 'ref_21');
  assert.equal(data.actions[0].accept_dialog, true);
});

test('clicks WP Reset browser confirmation button when a modal is visible', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'ji eita local site eita reset korbo',
    page: {
      url: 'https://local.test/wp-admin/tools.php?page=wp-reset',
      title: 'WP Reset - WordPress',
      visible_text: 'WP Reset Are you sure you want to reset this site?',
      forms: [
        {
          selector: '#wp-reset-form',
          fields: [
            {
              ref: 'ref_20',
              selector: '#wp-reset-confirm',
              name: 'wp-reset-confirm',
              type: 'text',
              placeholder: 'Type reset',
              value_length: 5,
            },
          ],
        },
      ],
      clickables: [
        { ref: 'ref_cancel', text: 'Cancel' },
        { ref: 'ref_ok', text: 'OK' },
      ],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.actions[0].type, 'click');
  assert.equal(data.actions[0].target, 'ref_ok');
  assert.equal(data.actions[0].accept_dialog, true);
});

test('asks once before final WP Reset page when approval is missing', () => {
  const data = parseReply({
    mode: 'agent_task',
    goal: 'wp reset final page e achi, ki kora lagbe bolo',
    page: {
      url: 'https://local.test/wp-admin/tools.php?page=wp-reset',
      title: 'WP Reset - WordPress',
      visible_text: 'WP Reset Reset Site Type reset to confirm',
      forms: [],
      clickables: [{ ref: 'ref_21', text: 'Reset Site' }],
    },
  }, { allowQuestionFallback: false });

  assert.equal(data.actions.length, 0);
  assert.equal(data.needs_approval, true);
  assert.match(data.questions[0], /Confirm/);
});
