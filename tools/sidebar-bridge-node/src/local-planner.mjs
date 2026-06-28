import { URL, URLSearchParams } from 'node:url';

const SAFE_MODES = new Set(['browser_plan', 'agent_chat', 'agent_plan', 'agent_task']);
const RISKY_RE = /\b(delete|remove|publish|payment|pay|checkout|purchase|merge|deploy|reset|destroy|password|otp|2fa|bank|card|withdraw|transfer|submit|post)\b/i;
const RISK_APPROVAL_RE = /\b(yes|yeah|yep|confirm|confirmed|proceed|go ahead|allow|approve|approved|ok|okay|sure|ji|jee|ha|haan|hmm|korbo|koro|kore dao|kore fel|cholbe|local site)\b/i;
const GREET_RE = /^\s*(hi|hello|hey|salam|assalamu|assalamu alaikum)\s*[!.]*\s*$/i;
const DOMAIN_RE = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/[^\s]*)?/i;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'ache', 'amar', 'ami', 'akta', 'ekta', 'e', 'er',
  'i', 'me', 'my', 'the', 'to', 'te', 'ta', 'told', 'tell', 'you', 'your',
  'theke', 'from', 'for', 'dao', 'daw', 'de', 'dekhao', 'dekhaw', 'dekhte',
  'dia', 'diye', 'koro', 'kor', 'kore', 'korte', 'jai', 'jao', 'goto', 'open',
  'go', 'search', 'google', 'image', 'images', 'img', 'video', 'videos', 'play',
  'current', 'page', 'url', 'ekhane', 'jekono', 'kon', 'konta', 'please', 'pls',
]);

export function buildLocalAgentReply(body = {}, { allowQuestionFallback = true } = {}) {
  const mode = String(body.mode || 'chat');
  if (!SAFE_MODES.has(mode)) return null;

  const goal = normalize(String(body.goal || body.message || ''));
  const page = isPlainObject(body.page) ? body.page : {};
  const taskState = isPlainObject(body.task_state) ? body.task_state : {};

  if (!goal) {
    return dump({
      reply: 'What should I do on this page?',
      reasoning_summary: ['No user goal was supplied.'],
      questions: ['What task should I run?'],
      actions: [],
      done: false,
      needs_approval: true,
    });
  }

  if (GREET_RE.test(goal)) {
    return dump({
      reply: 'Hi. How can I help?',
      reasoning_summary: ['The message is a greeting, so no browser action is needed.'],
      questions: [],
      actions: [],
      done: true,
      needs_approval: false,
    });
  }

  const captcha = captchaBlockReply(page);
  if (captcha) return captcha;

  const wpReset = wpResetPlan(goal, page, body.conversation_memory);
  if (wpReset) {
    return dump({
      reply: wpReset.reply,
      reasoning_summary: [pageEvidence(page), wpReset.reasoning],
      questions: wpReset.questions || [],
      actions: wpReset.action ? [wpReset.action] : [],
      done: Boolean(wpReset.done),
      needs_approval: Boolean(wpReset.needs_approval),
    });
  }

  if (RISKY_RE.test(goal) && !RISK_APPROVAL_RE.test(goal)) {
    return dump({
      reply: 'This may affect an account, content, payment, or settings. I need your exact approval before acting.',
      reasoning_summary: ['The request contains a risky action keyword, so local automation is blocked.'],
      questions: ['Do you want me to proceed with this risky action?'],
      actions: [],
      done: false,
      needs_approval: true,
    });
  }

  const adReply = youtubeAdReply(goal, page, taskState);
  if (adReply) return adReply;

  const readOnly = readOnlyReply(goal, page);
  if (readOnly) return readOnly;

  const completion = completionPlan(goal, page);
  if (completion) return completion;

  const demo = demoPlan(goal);
  if (demo) {
    return dump({
      reply: 'Testing mode e safe demo action dicchi.',
      reasoning_summary: [
        pageEvidence(page),
        takeReasoning(demo),
        'Demo action is non-destructive and does not submit forms.',
      ],
      questions: [],
      actions: [demo],
      done: false,
      needs_approval: false,
    });
  }

  const youtube = youtubePlan(goal, page);
  if (youtube) {
    return dump({
      reply: 'I found the next safe YouTube step.',
      reasoning_summary: [
        pageEvidence(page),
        takeReasoning(youtube),
        'This is a safe navigation/click action, not a form submission or destructive change.',
      ],
      questions: [],
      actions: [youtube],
      done: false,
      needs_approval: false,
    });
  }

  if (isYoutubeMediaGoal(goal)) {
    return dump({
      reply: 'I need a visible YouTube result or player control before I click anything.',
      reasoning_summary: [
        pageEvidence(page),
        'This looks like a YouTube/video/song request, so I will not click unrelated controls from the current page.',
      ],
      questions: ['Should I open YouTube search for this song/video?'],
      actions: [],
      done: false,
      needs_approval: true,
    });
  }

  const search = searchPlan(goal);
  if (search) {
    return dump({
      reply: 'I can run that search now.',
      reasoning_summary: [pageEvidence(page), takeReasoning(search), 'Search/navigation is a safe browser action.'],
      questions: [],
      actions: [search],
      done: false,
      needs_approval: false,
    });
  }

  const nav = navigationPlan(goal);
  if (nav) {
    return dump({
      reply: 'I can open that page now.',
      reasoning_summary: [pageEvidence(page), takeReasoning(nav), 'Opening a URL is safe and reversible.'],
      questions: [],
      actions: [nav],
      done: false,
      needs_approval: false,
    });
  }

  const themeWait = themeWaitPlan(goal, page, taskState);
  if (themeWait) {
    return dump({
      reply: 'Themes page open ache, theme list load/visible howar jonno wait kore abar check korchi.',
      reasoning_summary: [pageEvidence(page), takeReasoning(themeWait), 'The task is not complete yet, so the loop should continue.'],
      questions: [],
      actions: [themeWait],
      done: false,
      needs_approval: false,
    });
  }

  const click = clickPlan(goal, page);
  if (click) {
    return dump({
      reply: 'I found a matching page control.',
      reasoning_summary: [pageEvidence(page), takeReasoning(click), 'The target came from the current page snapshot.'],
      questions: [],
      actions: [click],
      done: false,
      needs_approval: false,
    });
  }

  if (!allowQuestionFallback) return null;

  const issueFallback = issueImplementationFallbackReply(goal, page);
  if (issueFallback) return issueFallback;

  return dump({
    reply: 'I need one more detail before acting.',
    reasoning_summary: [
      pageEvidence(page),
      'The local planner could not map this goal to one safe, obvious browser action.',
    ],
    questions: ['What exact page, search topic, button text, or URL should I use?'],
    actions: [],
    done: false,
    needs_approval: true,
  });
}

export function reason(body = {}) {
  const local = buildLocalAgentReply(body, { allowQuestionFallback: false });
  if (local) return { ok: true, text: local, source: 'node-local-planner', error: null };

  const fallback = buildLocalAgentReply(body, { allowQuestionFallback: true });
  return { ok: true, text: fallback, source: 'node-local-planner-fallback', error: null };
}

function captchaBlockReply(page) {
  if (!isCaptchaPage(page)) return null;

  return dump({
    reply: 'Google CAPTCHA/manual verification page e eshe gechi. Eta ami automate kore click korbo na. Apni "I am not a robot" checkbox click/complete korun; complete hole ami automatically same task continue korbo.',
    reasoning_summary: [
      pageEvidence(page),
      'The page is a Google/reCAPTCHA human verification challenge, so automation pauses and waits for the user to complete it manually.',
    ],
    questions: [],
    actions: [
      {
        type: 'wait_for_manual_verification',
        target: 'google-captcha',
        value: 180000,
        reason: 'Ask the user to complete the CAPTCHA manually, then continue when the page leaves the verification challenge.',
      },
    ],
    done: false,
    needs_approval: true,
  });
}

function isCaptchaPage(page = {}) {
  const url = String(page.url || '').toLowerCase();
  const title = normalize(String(page.title || '')).toLowerCase();
  const text = normalize(String(page.visible_text || '')).toLowerCase();
  const haystack = `${url} ${title} ${text}`;

  return url.includes('google.com/sorry/')
    || url.includes('/sorry/index')
    || haystack.includes('unusual traffic')
    || haystack.includes("i'm not a robot")
    || haystack.includes('i am not a robot')
    || haystack.includes('recaptcha')
    || haystack.includes('not a robot');
}

function readOnlyReply(goal, page) {
  return metaQuestionReply(goal, page)
    || capabilityReply(goal, page)
    || issueCheckReply(goal, page)
    || themeListReply(goal, page)
    || (!hasExplicitActionIntent(goal) ? pricingReply(goal, page) : null)
    || pageSummaryReply(goal, page)
    || (!hasExplicitActionIntent(goal) ? currentSiteReply(goal, page) : null);
}

function capabilityReply(goal, page) {
  const lower = goal.toLowerCase();
  const asks = lower.includes('what can you do')
    || lower.includes('how can you help')
    || lower.includes('capability')
    || lower.includes('capabilities')
    || lower.includes('fluid ki kore')
    || lower.includes('tumi ki korte paro')
    || lower.includes('tumi ki ki korte paro')
    || lower.includes('tomake diye ki kora jay')
    || lower.includes('tomake diye ki korte parbo');
  if (!asks) return null;

  return dump({
    reply: [
      'Ami FLUID sidebar. Current tab snapshot pore ami ei kajgula korte pari:',
      '- current page/URL info and visible content summarize',
      '- safe navigation, search, click, type, press, wait, and observe',
      '- multi-step browser flow continue kora with progress trace',
      '- risky/destructive kajer age confirmation chawa',
      'Complex code/site diagnosis hole same JSON contract diye AI planner e pathai.',
    ].join('\n'),
    reasoning_summary: [
      pageEvidence(page),
      'The user asked about sidebar capabilities, so no browser action is needed.',
    ],
    questions: [],
    actions: [],
    done: true,
    needs_approval: false,
  });
}

function issueCheckReply(goal, page) {
  if (!isPageIssueCheckGoal(goal) || asksImplementationWork(goal)) return null;
  if (navigationPlan(goal)) return null;

  const url = String(page.url || '').trim();
  if (!url) {
    return dump({
      reply: 'Current tab er inspectable URL snapshot e paini.',
      reasoning_summary: ['The user asked for an issue check, but no page snapshot URL was supplied.'],
      questions: ['Which tab or URL should I inspect?'],
      actions: [],
      done: false,
      needs_approval: true,
    });
  }

  const lines = ['Quick issue check from current snapshot:'];
  const title = normalize(String(page.title || ''));
  const parsed = parseUrl(url);
  lines.push(`- Site: ${parsed?.host || url}`);
  if (title) lines.push(`- Title: ${title}`);

  const layout = pageLayoutInfo(page);
  if (layout.viewportWidth && layout.documentWidth) {
    lines.push(`- Layout: viewport ${layout.viewportWidth}px, document ${layout.documentWidth}px`);
  }

  const signals = pageIssueSignals(goal, page);
  if (signals.length) {
    lines.push('- Snapshot issue signals:');
    for (const signal of signals.slice(0, 8)) lines.push(`  - ${signal}`);
  } else {
    lines.push('- No obvious snapshot-level issue signal found.');
    lines.push('- This is not a full visual proof; screenshot/mobile rendering can still reveal styling issues.');
  }

  return dump({
    reply: lines.join('\n'),
    reasoning_summary: [
      pageEvidence(page),
      'The issue check used current snapshot evidence: layout, images, controls, forms, dialogs, and visible text.',
      signals.length
        ? `Found ${signals.length} possible issue signal(s); no browser action is needed for this check.`
        : 'No obvious issue signal was found in the supplied snapshot; no browser action is needed for this check.',
    ],
    questions: [],
    actions: [],
    done: true,
    needs_approval: false,
  });
}

function issueImplementationFallbackReply(goal, page) {
  if (!isIssueTopicGoal(goal) || !asksImplementationWork(goal)) return null;

  const signals = pageIssueSignals(goal, page);
  const lines = [
    'Eta issue-fix/code request mone hocche, but current browser snapshot alone diye safe code fix decide kora jabe na.',
  ];

  if (signals.length) {
    lines.push('Snapshot evidence:');
    for (const signal of signals.slice(0, 6)) lines.push(`- ${signal}`);
  }

  return dump({
    reply: lines.join('\n'),
    reasoning_summary: [
      pageEvidence(page),
      signals.length
        ? `Found ${signals.length} visible issue signal(s), but no code/theme/plugin context was supplied.`
        : 'No code/theme/plugin context was supplied for this issue-fix request.',
      'A safe fix needs the relevant code surface, not only the rendered page snapshot.',
    ],
    questions: ['Relevant theme/plugin file, repo, or admin page ta open/provide korben?'],
    actions: [],
    done: false,
    needs_approval: true,
  });
}

function metaQuestionReply(goal, page) {
  const lower = goal.toLowerCase();
  const asksFast = (lower.includes('fast') || lower.includes('taratari') || lower.includes('quick'))
    && /\b(ans|answer|reply|diccho|diteso|dile|daw|dao)\b/.test(lower);
  const asksHow = lower.includes('kivabe')
    && /\b(ans|answer|reply|kaj|work|korcho|diccho|diteso)\b/.test(lower);
  if (!asksFast && !asksHow) return null;

  return dump({
    reply: 'Fast answer dicchi karon eta simple/local route e solve hocche. Greeting, current page info, obvious safe click/search, ba visible page snapshot theke list/price local planner direct answer kore. Complex/unclear task hole then AI planner e jay, tai wait hote pare.',
    reasoning_summary: [
      pageEvidence(page),
      'The user asked how the sidebar answered quickly, so this is a conversational explanation.',
      'No browser action is needed for this question.',
    ],
    questions: [],
    actions: [],
    done: true,
    needs_approval: false,
  });
}

function pageSummaryReply(goal, page) {
  const lower = goal.toLowerCase();
  const asksSummary = lower.includes('summarize this page')
    || lower.includes('summarise this page')
    || lower.includes('summary of this page')
    || lower.includes('describe this page')
    || lower.includes('what is on this page')
    || lower.includes("what's on this page")
    || lower.includes('page e ki ache')
    || lower.includes('page a ki ache')
    || lower.includes('ei page e ki ache')
    || lower.includes('ei page a ki ache')
    || lower.includes('current page e ki ache')
    || lower.includes('current page a ki ache')
    || lower.includes('ekhane ki ache')
    || lower.includes('page ta dekhe bolo')
    || lower.includes('page ta check kore bolo')
    || lower.includes('inspect current page');
  if (!asksSummary) return null;

  // Leave bug diagnosis to the AI provider; the local planner only summarizes visible snapshot facts.
  if (/\b(issue|problem|bug|error|fix|fixed|responsive|broken|validation|missing)\b/i.test(lower)) return null;

  const url = String(page.url || '').trim();
  if (!url) {
    return dump({
      reply: 'Current tab er inspectable URL snapshot e paini.',
      reasoning_summary: ['The user asked for a page summary, but no page snapshot URL was supplied.'],
      questions: ['Which tab or URL should I inspect?'],
      actions: [],
      done: false,
      needs_approval: true,
    });
  }

  const lines = ['Current page snapshot summary:'];
  const title = normalize(String(page.title || ''));
  const parsed = parseUrl(url);
  lines.push(`- Site: ${parsed?.host || url}`);
  if (title) lines.push(`- Title: ${title}`);

  const viewport = isPlainObject(page.viewport) ? page.viewport : {};
  if (viewport.width && viewport.height) {
    lines.push(`- Viewport: ${viewport.width}x${viewport.height}`);
  }

  const headings = pageHeadings(page).slice(0, 5);
  if (headings.length) lines.push(`- Headings: ${headings.join(' | ')}`);

  const visiblePreview = textPreview(page.visible_text, 240);
  if (visiblePreview) lines.push(`- Visible text: ${visiblePreview}`);

  const controls = clickableLabels(page).slice(0, 6);
  if (controls.length) lines.push(`- Visible controls: ${controls.join(' | ')}`);

  const forms = Array.isArray(page.forms) ? page.forms : [];
  if (forms.length) {
    const fieldCount = forms.reduce((total, form) => total + (Array.isArray(form?.fields) ? form.fields.length : 0), 0);
    lines.push(`- Forms: ${forms.length} form(s), ${fieldCount} visible field(s)`);
  }

  return dump({
    reply: lines.join('\n'),
    reasoning_summary: [
      pageEvidence(page),
      'The answer uses only the current tab snapshot: URL, title, visible text, controls, and forms.',
      'This is read-only, so no browser action is needed.',
    ],
    questions: [],
    actions: [],
    done: true,
    needs_approval: false,
  });
}

function currentSiteReply(goal, page) {
  const lower = goal.toLowerCase();
  const asks = lower.includes('kon site')
    || lower.includes('which site')
    || lower.includes('what site')
    || lower.includes('current site')
    || lower.includes('current page')
    || lower.includes('kothay acho')
    || lower.includes('kothai acho')
    || lower.includes('where am i')
    || lower.includes('where are you');
  if (!asks) return null;

  const url = String(page.url || '').trim();
  const title = String(page.title || '').trim();
  if (!url) {
    return dump({
      reply: 'Current tab er URL snapshot e paini.',
      reasoning_summary: ['The user asked which site is open, but no page URL was supplied.'],
      questions: ['Which tab or URL should I inspect?'],
      actions: [],
      done: false,
      needs_approval: true,
    });
  }

  const parsed = parseUrl(url);
  const host = parsed ? parsed.host : url;
  let reply = `Haan, ekhon ${host} site e achi.`;
  if (title) reply += `\nPage: ${title}`;
  reply += `\nURL: ${url}`;

  return dump({
    reply,
    reasoning_summary: [pageEvidence(page), 'The user asked for the current site/page, so no browser action is needed.'],
    questions: [],
    actions: [],
    done: true,
    needs_approval: false,
  });
}

function pricingReply(goal, page) {
  if (!/\b(price|pricing|plan|plans|dam|taka|koto)\b/i.test(goal)) return null;
  const visibleText = normalize(String(page.visible_text || ''));
  if (!visibleText.includes('$')) return null;

  const plans = pricingPlansFromText(visibleText);
  if (!plans.length) return null;

  const lines = ['Current page snapshot theke pricing list:'];
  for (const plan of plans.slice(0, 6)) {
    let label = String(plan.name);
    if (plan.sites) label += ` (${plan.sites})`;

    let price = String(plan.price);
    if (plan.term) price += `/${String(plan.term).toLowerCase()}`;

    const details = [price];
    if (plan.regular) details.push(`regular ${plan.regular}`);
    if (plan.save) details.push(`save ${plan.save}`);
    if (plan.renewal) details.push(`renews ${plan.renewal}/yr`);
    lines.push(`- ${label}: ${details.join(', ')}`);
  }

  return dump({
    reply: lines.join('\n'),
    reasoning_summary: [
      pageEvidence(page),
      `Found ${plans.length} pricing item(s) in the current page visible text.`,
      'This is a read-only answer, so no browser action is needed.',
    ],
    questions: [],
    actions: [],
    done: true,
    needs_approval: false,
  });
}

function pricingPlansFromText(text) {
  const plans = [];
  const planPattern = /(?:(?:Most Popular)\s+)?(?<sites>(?:\d+\s+Sites?|Unlimited Sites?))\s+(?<name>Starter|Agency|Pro)\s+.*?(?<regular>\$\d[\d,]*)\s+Save\s+(?<save>\d+%)\s+(?<price>\$\d[\d,]*)\s*\/(?<term>Year|Month)(?:\s+Renews at\s+(?<renewal>\$\d[\d,]*)\/yr)?/gi;
  for (const match of text.matchAll(planPattern)) {
    plans.push({
      name: match.groups.name,
      sites: match.groups.sites,
      regular: match.groups.regular,
      save: match.groups.save,
      price: match.groups.price,
      term: match.groups.term,
      renewal: match.groups.renewal || '',
    });
  }

  const bundle = /Own It Forever\s+Mega Bundle\b.*?Pay\s+(?<price>\$\d[\d,]*)\s*\/(?<term>Once)\s+(?<regular>\$\d[\d,]*)\s+separately/i.exec(text);
  if (bundle?.groups) {
    plans.push({
      name: 'Mega Bundle',
      sites: '',
      regular: bundle.groups.regular,
      save: '',
      price: bundle.groups.price,
      term: bundle.groups.term,
      renewal: '',
    });
  }
  return plans;
}

function themeListReply(goal, page) {
  if (!isThemeListGoal(goal)) return null;
  const url = String(page.url || '');
  const title = String(page.title || '');
  const visibleText = normalize(String(page.visible_text || ''));
  const parsed = parseUrl(url);
  const isThemePage = (parsed?.pathname || '').toLowerCase().includes('themes') || title.toLowerCase().includes('theme');
  if (!isThemePage) return null;

  const themes = themeItemsFromPage(page, visibleText);
  if (!themes.length) return null;

  const lines = ['Current themes page theke theme list:'];
  for (const item of themes.slice(0, 12)) {
    lines.push(`- ${item.name}${item.price ? ` - ${item.price}` : ''}`);
  }

  return dump({
    reply: lines.join('\n'),
    reasoning_summary: [
      pageEvidence(page),
      `Found ${themes.length} theme item(s) from the current themes page snapshot.`,
      'This answers after the requested Themes page is open, so no extra browser action is needed.',
    ],
    questions: [],
    actions: [],
    done: true,
    needs_approval: false,
  });
}

function themeWaitPlan(goal, page, taskState) {
  if (!isThemeListGoal(goal)) return null;
  const url = String(page.url || '');
  const title = String(page.title || '');
  const visibleText = normalize(String(page.visible_text || ''));
  const parsed = parseUrl(url);
  const isThemePage = (parsed?.pathname || '').toLowerCase().includes('themes') || title.toLowerCase().includes('theme');
  if (!isThemePage || themeItemsFromPage(page, visibleText).length) return null;

  const observations = Array.isArray(taskState.observations) ? taskState.observations : [];
  const recentWaits = observations.slice(-4)
    .filter((item) => String(item?.message || '').toLowerCase().includes('waited')).length;

  return {
    type: 'wait',
    target: 'theme-list',
    value: recentWaits < 2 ? 1200 : 2000,
    reason: 'Wait for the themes list/cards to finish loading before answering.',
    _reasoning: 'The current page is the Themes page, but the snapshot does not yet expose theme list items.',
  };
}

function isThemeListGoal(goal) {
  const lower = goal.toLowerCase();
  return lower.includes('theme') && /\b(list|show|dao|daw|dekhaw|dekhao)\b/.test(lower);
}

function themeItemsFromPage(page, visibleText) {
  const items = [];
  const seen = new Set();
  const clickables = Array.isArray(page.clickables) ? page.clickables : [];

  for (const clickable of clickables) {
    if (!isPlainObject(clickable)) continue;
    const href = String(clickable.href || '').toLowerCase();
    const text = normalize(String(clickable.text || ''));
    if (!href.includes('/themes/') || !text) continue;
    const candidate = themeNameFromText(text);
    if (candidate && !seen.has(candidate.toLowerCase())) {
      seen.add(candidate.toLowerCase());
      items.push({ name: candidate, price: '' });
    }
  }

  const themePattern = /\b(?<name>OneListing(?:\s+Pro)?|d[A-Z][A-Za-z]+)\s+(?:(?:New|Trending)\s+)?(?:(?<price>\$\d[\d,]*)\s+)?(?<desc>[^$]{0,140}?Theme[^$]{0,100}?)(?=\s+Live Preview|\s+Details)/g;
  for (const match of visibleText.matchAll(themePattern)) {
    const name = normalize(match.groups.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    const desc = match.groups.desc || '';
    const price = match.groups.price || (desc.toLowerCase().includes('free') ? 'Free' : '');
    seen.add(name.toLowerCase());
    items.push({ name, price });
  }

  return items;
}

function themeNameFromText(text) {
  return /\b(OneListing(?:\s+Pro)?|d[A-Z][A-Za-z]+)\b/.exec(text)?.[1] || '';
}

function youtubeAdReply(goal, page, taskState) {
  if (!isSkipAdGoal(goal)) return null;

  if (!isYoutubeUrl(String(page.url || ''))) {
    return dump({
      reply: 'I can skip ads only when the current tab is a YouTube player.',
      reasoning_summary: [pageEvidence(page), 'The user asked to skip an ad, but the current page is not a YouTube page.'],
      questions: ['Open the YouTube tab/video first?'],
      actions: [],
      done: false,
      needs_approval: true,
    });
  }

  const skipTarget = youtubeSkipAdTarget(page);
  if (skipTarget) {
    return dump({
      reply: 'I found the Skip Ad control.',
      reasoning_summary: [
        pageEvidence(page),
        `The current YouTube snapshot has a visible "${skipTarget.text.slice(0, 80)}" control.`,
      ],
      questions: [],
      actions: [{
        type: 'click',
        target: skipTarget.target,
        value: '',
        reason: `Click visible YouTube ad control: ${skipTarget.text.slice(0, 80)}.`,
      }],
      done: false,
      needs_approval: false,
    });
  }

  const observations = Array.isArray(taskState.observations) ? taskState.observations : [];
  const recentWaits = observations.slice(-4)
    .filter((item) => String(item?.result || item?.message || '').toLowerCase().includes('youtube-ad')).length;
  if (recentWaits < 2) {
    return dump({
      reply: 'Skip Ad button ekhono visible na, wait kore abar check korchi.',
      reasoning_summary: [pageEvidence(page), 'The current YouTube snapshot does not expose a Skip Ad button yet.'],
      questions: [],
      actions: [{
        type: 'wait',
        target: 'youtube-ad',
        value: 1200,
        reason: 'Wait briefly for a YouTube Skip Ad button to appear.',
      }],
      done: false,
      needs_approval: false,
    });
  }

  return dump({
    reply: 'I do not see a Skip Ad button on the current YouTube player right now.',
    reasoning_summary: [pageEvidence(page), 'After waiting, the supplied page snapshots still did not show a Skip Ad control.'],
    questions: [],
    actions: [],
    done: true,
    needs_approval: false,
  });
}

function isSkipAdGoal(goal) {
  return goal.toLowerCase().includes('skip') && /\b(ad|ads|add|adds)\b/i.test(goal);
}

function youtubeSkipAdTarget(page) {
  const clickables = Array.isArray(page.clickables) ? page.clickables : [];
  for (const item of clickables) {
    if (!isPlainObject(item)) continue;
    const text = normalize(String(item.text || item.aria_label || ''));
    const lower = text.toLowerCase();
    if (!lower.includes('skip') || !/\b(ad|ads)\b/.test(lower)) continue;
    const target = text ? `text=${text}` : String(item.ref || item.selector || '');
    if (target) return { target, text: text || 'Skip Ad' };
  }
  return null;
}

function completionPlan(goal, page) {
  const currentUrl = String(page.url || '');
  const parsed = parseUrl(currentUrl);
  const host = (parsed?.host || '').toLowerCase();
  const lower = goal.toLowerCase();

  if (isYoutubeUrl(currentUrl) && (lower.includes('youtube') || isPlaybackGoal(goal))) {
    const query = extractQuery(goal, new Set(['youtube']));
    const wantsPlay = isPlaybackGoal(goal);
    if (wantsPlay && parsed?.pathname.includes('/watch')) {
      if (!query || queryMatchesPage(query, page)) {
        return doneReply(page, 'The current page is already a matching YouTube watch page.');
      }
      return null;
    }
    if (query && parsed?.pathname.includes('results')) {
      const currentQuery = normalize((parsed.searchParams.get('search_query') || '').replace(/\+/g, ' ')).toLowerCase();
      if (currentQuery.includes(normalize(query).toLowerCase())) {
        if (wantsPlay) return null;
        return doneReply(page, `The current YouTube results page already matches "${query}".`);
      }
    } else if (!query && parsed?.pathname === '/') {
      return doneReply(page, 'The current page is already the YouTube homepage.');
    }
  }

  if (isDemoGoal(goal) && host === 'example.com') {
    return doneReply(page, 'The safe demo page is already open, so no extra click is needed.');
  }

  if ((lower.includes('search') || lower.includes('google') || lower.includes('image') || lower.includes('images')) && host.includes('google.')) {
    const query = extractQuery(goal);
    const currentQuery = normalize((parsed?.searchParams.get('q') || '').replace(/\+/g, ' ')).toLowerCase();
    const wantsImage = lower.includes('image') || lower.includes('images') || lower.includes('img');
    const isImagePage = parsed?.searchParams.get('tbm') === 'isch';
    if (query && currentQuery.includes(normalize(query).toLowerCase()) && (!wantsImage || isImagePage)) {
      return doneReply(page, `The current Google ${wantsImage ? 'Images ' : ''}results already match "${query}".`);
    }
  }

  const nav = navigationPlan(goal);
  if (nav) {
    const targetHost = parseUrl(String(nav.target || ''))?.host.toLowerCase();
    if (targetHost && host === targetHost) {
      return doneReply(page, `The current page is already on ${targetHost}.`);
    }
  }

  return null;
}

function demoPlan(goal) {
  if (!isDemoGoal(goal)) return null;
  return {
    type: 'navigate',
    target: 'https://example.com/',
    value: 'https://example.com/',
    reason: 'Open a safe demo page.',
    _reasoning: 'The goal asks for a testing/demo action, so opening example.com is enough proof without risky clicks.',
  };
}

function isDemoGoal(goal) {
  const lower = goal.toLowerCase();
  return lower.includes('testing mode')
    || lower.includes('test mode')
    || lower.includes('demo')
    || lower.includes('kichu kore dekhao')
    || lower.includes('kisu kore dekhao')
    || lower.includes('ekta kichu kore dekhao');
}

function doneReply(page, reason) {
  return dump({
    reply: 'Done.',
    reasoning_summary: [pageEvidence(page), reason],
    questions: [],
    actions: [],
    done: true,
    needs_approval: false,
  });
}

function youtubePlan(goal, page) {
  const lower = goal.toLowerCase();
  const currentUrl = String(page.url || '');
  const parsed = parseUrl(currentUrl);
  const isYoutubePage = isYoutubeUrl(currentUrl);
  const wantsYoutube = lower.includes('youtube') || isPlaybackGoal(goal);
  const wantsPlay = isPlaybackGoal(goal);
  if (!wantsYoutube) return null;

  const query = extractQuery(goal, new Set(['youtube']));

  if (!isYoutubePage) {
    if (!query) {
      return {
        type: 'navigate',
        target: 'https://www.youtube.com/',
        value: 'https://www.youtube.com/',
        reason: 'Open YouTube homepage.',
        _reasoning: 'The goal asks to go to YouTube and no search query was provided.',
      };
    }
    const url = youtubeSearchUrl(query);
    return {
      type: 'navigate',
      target: url,
      value: url,
      reason: `Open YouTube results for ${query}.`,
      _reasoning: `The goal names YouTube with query "${query}".`,
    };
  }

  if (query && parsed?.pathname.includes('/watch') && !queryMatchesPage(query, page)) {
    const url = youtubeSearchUrl(query);
    return {
      type: 'navigate',
      target: url,
      value: url,
      reason: `Search YouTube for ${query}.`,
      _reasoning: `The current YouTube watch page does not match the requested query "${query}".`,
    };
  }

  if (wantsPlay) {
    const video = firstYoutubeVideo(page, query);
    if (video) {
      return {
        type: 'navigate',
        target: video.href,
        value: video.href,
        reason: `Open visible YouTube video: ${video.text.slice(0, 80)}.`,
        _reasoning: 'The current YouTube snapshot contains a visible watch link, so navigating to its href avoids stale click refs.',
      };
    }

    if (query) {
      const currentQuery = normalize((parsed?.searchParams.get('search_query') || '').replace(/\+/g, ' ')).toLowerCase();
      if (parsed?.pathname.includes('results') && currentQuery.includes(normalize(query).toLowerCase())) {
        return {
          type: 'wait',
          target: 'youtube-results',
          value: 1200,
          reason: 'Wait for YouTube video results to finish loading.',
          _reasoning: 'The current YouTube results URL matches the query, but the snapshot does not expose a watch link yet.',
        };
      }
      const url = youtubeSearchUrl(query);
      return {
        type: 'navigate',
        target: url,
        value: url,
        reason: `Search YouTube for ${query}.`,
        _reasoning: `The current page is YouTube and the extracted video query is "${query}".`,
      };
    }
  }

  if (query) {
    const url = youtubeSearchUrl(query);
    return {
      type: 'navigate',
      target: url,
      value: url,
      reason: `Search YouTube for ${query}.`,
      _reasoning: `The current page is YouTube and the extracted query is "${query}".`,
    };
  }

  return null;
}

function searchPlan(goal) {
  const lower = goal.toLowerCase();
  const issueContext = /\b(issue|problem|bug|error|fix|responsive|validation|required|missing|field|upload)\b/i.test(lower);
  if (issueContext && !/\b(search|google|khoj)\b/i.test(lower)) return null;

  const wantsSearch = lower.includes('search') || lower.includes('google') || lower.includes('khoj');
  const wantsImage = lower.includes('image') || lower.includes('images') || lower.includes('img');
  if (!wantsSearch && !wantsImage) return null;

  const query = extractQuery(goal);
  if (!query) return null;
  return {
    type: 'search',
    target: query,
    value: query,
    mode: wantsImage ? 'images' : 'web',
    reason: `Search for ${query}.`,
    _reasoning: `The goal is a ${wantsImage ? 'Google Images' : 'Google'} search and the extracted query is "${query}".`,
  };
}

function navigationPlan(goal) {
  const lower = goal.toLowerCase();
  if (!/\b(open|go|jao|navigate)\b/.test(lower)) return null;

  const match = DOMAIN_RE.exec(goal);
  if (!match) return null;
  const raw = match[0].trim().replace(/[.,)]$/, '');
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return {
    type: 'navigate',
    target: url,
    value: url,
    reason: `Open ${url}.`,
    _reasoning: `The goal contains a URL/domain "${raw}".`,
  };
}

function wpResetPlan(goal, page, conversationMemory = {}) {
  const goalText = normalize(goal);
  const memoryText = normalize([
    isPlainObject(conversationMemory) ? conversationMemory.summary : '',
    isPlainObject(conversationMemory?.last_task) ? conversationMemory.last_task.goal : '',
    isPlainObject(conversationMemory?.last_task) ? conversationMemory.last_task.reply : '',
  ].filter(Boolean).join(' '));
  const directResetGoal = isWpResetGoal(goalText);
  const memoryResetContinuation = isContinuationApproval(goalText) && isWpResetGoal(memoryText);

  if (!directResetGoal && !memoryResetContinuation) return null;
  const contextText = normalize([goalText, memoryResetContinuation ? memoryText : ''].filter(Boolean).join(' '));

  const admin = wpAdminContext(page);
  if (!admin.base) {
    return {
      reply: 'WordPress admin URL pachhi na. Current site/admin tab open korle ami WP Reset flow chalate parbo.',
      reasoning: 'The task is a WP Reset flow, but the current page URL is not usable for a WordPress admin route.',
      questions: ['WordPress admin tab open kore dao, then bollei ami continue korbo.'],
      needs_approval: true,
    };
  }

  const approved = hasRiskApproval(contextText);
  const path = admin.url.pathname.toLowerCase();
  const pageText = normalize(String(page.visible_text || '')).toLowerCase();

  if (isWpResetToolPage(page)) {
    if (!approved) {
      return {
        reply: 'WP Reset page e achi. Final site reset destructive, tai ekbar confirm korlei execute korbo.',
        reasoning: 'The current page appears to be the WP Reset tool page, but there is no explicit reset approval in the current goal or memory.',
        questions: ['Confirm korben je ei site reset korte hobe?'],
        needs_approval: true,
      };
    }

    const confirmField = wpResetConfirmField(page);
    if (confirmField) {
      return {
        reply: 'WP Reset confirm field e "reset" type korchi.',
        reasoning: 'The WP Reset page exposes a confirmation input that still needs the required reset keyword.',
        action: {
          type: 'type',
          target: confirmField,
          value: 'reset',
          reason: 'Type the required WP Reset confirmation keyword after explicit user approval.',
        },
      };
    }

    const finalButton = wpResetFinalButton(page);
    if (finalButton) {
      return {
        reply: 'Final reset button click korchi.',
        reasoning: 'The reset confirmation appears ready and the final reset control is visible.',
        action: {
          type: 'click',
          target: finalButton,
          value: '',
          reason: 'Click the final WP Reset control after explicit user approval.',
          accept_dialog: true,
        },
      };
    }

    return {
      reply: 'WP Reset page e achi, final control load/visible howar jonno abar observe korchi.',
      reasoning: 'The reset page is open, but the confirmation input or final reset button is not visible in the snapshot yet.',
      action: { type: 'observe', target: 'current page', value: '', reason: 'Refresh the page snapshot before deciding the final reset target.' },
    };
  }

  if (path.includes('/wp-admin/plugins.php')) {
    const activateHref = wpResetHref(page, /action=activate/i);
    if (activateHref) {
      return {
        reply: 'WP Reset plugin inactive dekhacche, activate korchi.',
        reasoning: 'The Plugins page snapshot contains a WP Reset activation link with a WordPress nonce.',
        action: {
          type: 'navigate',
          target: activateHref,
          value: activateHref,
          reason: 'Open the WP Reset activation URL from the current Plugins page snapshot.',
        },
      };
    }

    if (pageText.includes('wp reset') && (pageText.includes('deactivate') || pageText.includes('active'))) {
      const url = adminUrl(admin, 'tools.php?page=wp-reset');
      return {
        reply: 'WP Reset plugin active mone hocche, tool page open korchi.',
        reasoning: 'The Plugins page includes WP Reset and active/deactivate text, so the next step is the WP Reset tool page.',
        action: { type: 'navigate', target: url, value: url, reason: 'Open WP Reset tools page.' },
      };
    }

    const installUrl = adminUrl(admin, 'plugin-install.php?s=wp+reset&tab=search&type=term');
    return {
      reply: 'WP Reset plugin plugins list e clear dekhte pacchi na, install/search page open korchi.',
      reasoning: 'The Plugins page did not expose an activate or active WP Reset row, so searching plugin-install is the next safe step.',
      action: { type: 'navigate', target: installUrl, value: installUrl, reason: 'Search WP Reset in WordPress plugin installer.' },
    };
  }

  if (path.includes('/wp-admin/plugin-install.php')) {
    const installHref = wpResetHref(page, /action=install-plugin/i);
    if (installHref) {
      return {
        reply: 'WP Reset plugin install korchi.',
        reasoning: 'The plugin installer snapshot contains the WP Reset install URL.',
        action: {
          type: 'navigate',
          target: installHref,
          value: installHref,
          reason: 'Open the WP Reset install URL from the current plugin installer page.',
        },
      };
    }

    const activateHref = wpResetHref(page, /action=activate/i);
    if (activateHref) {
      return {
        reply: 'WP Reset installed, activate korchi.',
        reasoning: 'The plugin installer snapshot contains a WP Reset activate URL.',
        action: { type: 'navigate', target: activateHref, value: activateHref, reason: 'Activate WP Reset after installation.' },
      };
    }

    return {
      reply: 'WP Reset search/install result load howar jonno wait korchi.',
      reasoning: 'The plugin installer is open but the WP Reset install/activate link is not visible yet.',
      action: { type: 'wait', target: 'wp-reset-plugin-search', value: 1500, reason: 'Wait for WordPress plugin search results.' },
    };
  }

  const pluginsUrl = adminUrl(admin, 'plugins.php?s=wp+reset&plugin_status=all');
  return {
    reply: 'Plugins page e giye WP Reset status check korchi.',
    reasoning: 'The current page is WordPress admin, and the reset flow starts by checking whether WP Reset is installed/active.',
    action: { type: 'navigate', target: pluginsUrl, value: pluginsUrl, reason: 'Open Plugins search filtered to WP Reset.' },
  };
}

function clickPlan(goal, page) {
  const lower = goal.toLowerCase();
  if (!/\b(click|open|press|tap|play)\b/.test(lower)) return null;

  const clickables = Array.isArray(page.clickables) ? page.clickables : [];
  const terms = words(goal).filter((word) => !STOP_WORDS.has(word) && word.length > 2);
  if (!terms.length) return null;

  let best = null;
  let bestScore = 0;
  for (const item of clickables) {
    if (!isPlainObject(item)) continue;
    const text = normalize(String(item.text || item.href || ''));
    if (!text) continue;
    const score = terms.filter((term) => text.toLowerCase().includes(term)).length;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }

  if (!best || bestScore === 0) return null;
  const label = normalize(String(best.text || best.href || best.ref || best.selector || ''));
  const href = String(best.href || '').trim();
  if (/^https?:\/\//i.test(href)) {
    if (sameUrlWithoutHash(href, String(page.url || ''))) return null;
    return {
      type: 'navigate',
      target: href,
      value: href,
      reason: `Open visible page link: ${label.slice(0, 80)}.`,
      _reasoning: `The page snapshot has a matching link "${label.slice(0, 80)}" with URL ${href}.`,
    };
  }

  const target = String(best.ref || best.selector || '');
  if (!target) return null;
  return {
    type: 'click',
    target,
    value: '',
    reason: `Click visible page control: ${label.slice(0, 80)}.`,
    _reasoning: `The page snapshot has a clickable target matching ${bestScore} goal word(s): "${label.slice(0, 80)}".`,
  };
}

function hasExplicitActionIntent(goal) {
  return /\b(click|open|press|tap|tab|jao|go|goto|navigate|play|watch)\b/i.test(goal);
}

function isPageIssueCheckGoal(goal) {
  const lower = goal.toLowerCase();
  const asksCheck = /\b(check|inspect|verify|review|test|look|dekho|dekhaw|dekhao|dekhon|dekhe|bolo)\b/i.test(lower)
    || lower.includes('hoise naki')
    || lower.includes('ache naki')
    || lower.includes('thik ache')
    || lower.includes('thik hoise')
    || lower.includes('fixed')
    || lower.includes('resolved');
  return asksCheck && isIssueTopicGoal(goal);
}

function isIssueTopicGoal(goal) {
  return /\b(issue|problem|bug|error|responsive|mobile|display|layout|overflow|image|logo|validation|required|missing|field|checkbox|blank|loading|spinner|card|upload)\b/i.test(goal);
}

function asksImplementationWork(goal) {
  const lower = goal.toLowerCase();
  if (
    lower.includes('fix hoise')
    || lower.includes('fixed')
    || lower.includes('resolved')
    || lower.includes('thik hoise')
    || lower.includes('hoise naki')
  ) {
    return false;
  }

  return /\b(implement|implementation|code|css|js|javascript|php|snippet|write|add|change|modify|solve|repair)\b/i.test(lower)
    || /\bfix\s+(koro|kor|kore|dao|daw|now|it|this)\b/i.test(lower)
    || /\b(thik|solve)\s+(koro|kor|kore|dao|daw)\b/i.test(lower);
}

function pageIssueSignals(goal, page) {
  const signals = [];
  const lowerGoal = goal.toLowerCase();
  const layout = pageLayoutInfo(page);
  const viewportWidth = layout.viewportWidth || Number(page.viewport?.width || 0);

  if (layout.horizontalOverflow) {
    signals.push(`Horizontal overflow detected: document width ${layout.documentWidth}px exceeds viewport ${layout.viewportWidth}px.`);
  }

  const images = Array.isArray(page.images) ? page.images : [];
  const imageSignals = [];
  for (const image of images) {
    if (!isPlainObject(image)) continue;
    const box = isPlainObject(image.box) ? image.box : {};
    const width = Number(box.width || 0);
    const height = Number(box.height || 0);
    const x = Number(box.x || 0);
    const label = normalize(String(image.alt || image.selector || image.src || 'image')).slice(0, 80) || 'image';
    if (viewportWidth && width > viewportWidth + 2) {
      imageSignals.push(`${label} image is wider than viewport (${width}px > ${viewportWidth}px).`);
    } else if (viewportWidth && width > viewportWidth * 0.92 && (x < -2 || x + width > viewportWidth + 2)) {
      imageSignals.push(`${label} image appears clipped or overflowing the viewport.`);
    } else if ((lowerGoal.includes('logo') || lowerGoal.includes('image')) && (!width || !height)) {
      imageSignals.push(`${label} image has no measurable displayed size in the snapshot.`);
    }
  }
  signals.push(...imageSignals.slice(0, 4));

  if ((lowerGoal.includes('image') || lowerGoal.includes('logo')) && !images.length) {
    signals.push('No visible image metadata was captured on the current page.');
  }

  const blankChoices = blankChoiceControls(page);
  if (blankChoices > 0 && /\b(checkbox|radio|label|text|blank|missing|certification|vehicle)\b/i.test(lowerGoal)) {
    signals.push(`${blankChoices} visible checkbox/radio control(s) have no captured label text.`);
  }

  const requiredFiles = requiredFileFields(page);
  if (requiredFiles > 0 && /\b(image|file|upload|required|validation)\b/i.test(lowerGoal)) {
    signals.push(`${requiredFiles} required file/image upload field(s) are visible in the form snapshot.`);
  }

  const text = normalize(String(page.visible_text || '')).toLowerCase();
  const textSignals = [
    ['required', 'Visible page text includes a required-field message.'],
    ['error', 'Visible page text includes an error message.'],
    ['loading', 'Visible page text includes loading text.'],
    ['spinner', 'Visible page text includes spinner/loading text.'],
  ];
  for (const [needle, message] of textSignals) {
    if (text.includes(needle)) signals.push(message);
  }

  const dialogs = Array.isArray(page.dialogs) ? page.dialogs : [];
  if (dialogs.length) signals.push(`${dialogs.length} visible dialog/modal element(s) are present.`);

  return Array.from(new Set(signals));
}

function pageLayoutInfo(page) {
  const layout = isPlainObject(page.layout) ? page.layout : {};
  const viewport = isPlainObject(page.viewport) ? page.viewport : {};
  const viewportWidth = Number(layout.viewport_width || viewport.width || 0);
  const documentWidth = Number(layout.document_width || 0);
  return {
    viewportWidth,
    viewportHeight: Number(layout.viewport_height || viewport.height || 0),
    documentWidth,
    documentHeight: Number(layout.document_height || 0),
    horizontalOverflow: Boolean(layout.horizontal_overflow || (viewportWidth && documentWidth > viewportWidth + 2)),
  };
}

function blankChoiceControls(page) {
  const clickables = Array.isArray(page.clickables) ? page.clickables : [];
  let count = 0;
  for (const item of clickables) {
    if (!isPlainObject(item)) continue;
    const type = String(item.type || '').toLowerCase();
    const role = String(item.role || '').toLowerCase();
    const text = normalize(String(item.text || item.aria_label || ''));
    if ((type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio') && !text) count += 1;
  }
  return count;
}

function requiredFileFields(page) {
  const forms = Array.isArray(page.forms) ? page.forms : [];
  let count = 0;
  for (const form of forms) {
    if (!isPlainObject(form)) continue;
    const fields = Array.isArray(form.fields) ? form.fields : [];
    for (const field of fields) {
      if (!isPlainObject(field)) continue;
      const type = String(field.type || '').toLowerCase();
      const accept = String(field.accept || '').toLowerCase();
      if (field.required && (type === 'file' || accept.includes('image'))) count += 1;
    }
  }
  return count;
}

function pageHeadings(page) {
  const tree = String(page.accessibility_tree || '');
  const headings = [];
  const seen = new Set();
  for (const line of tree.split('\n')) {
    const match = /^heading\s+"([^"]+)"/i.exec(line.trim());
    if (!match) continue;
    const text = normalize(match[1]);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    headings.push(text.length <= 90 ? text : `${text.slice(0, 87)}...`);
  }
  return headings;
}

function clickableLabels(page) {
  const clickables = Array.isArray(page.clickables) ? page.clickables : [];
  const labels = [];
  const seen = new Set();
  for (const item of clickables) {
    if (!isPlainObject(item)) continue;
    const text = normalize(String(item.text || item.aria_label || item.placeholder || ''));
    if (!text || text.length > 90) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(text);
  }
  return labels;
}

function textPreview(value, limit = 240) {
  const text = normalize(String(value || ''));
  if (!text) return '';
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit).replace(/\s+\S*$/, '').trim();
  return `${clipped || text.slice(0, limit)}...`;
}

function isWpResetGoal(text) {
  const lower = String(text || '').toLowerCase();
  if (isResetOnlySafetyBoundary(lower)) return false;
  if (lower.includes('wp reset')) return true;
  if (lower.includes('wordpress reset')) return true;
  if (lower.includes('plugin active') && lower.includes('reset')) return true;
  if (lower.includes('plugin activate') && lower.includes('reset')) return true;
  if (/\breset\b/.test(lower) && /\b(site|wordpress|wp|plugin|local|database|db)\b/.test(lower)) return true;
  return /\breset\s+(kor|koro|korbo|korte|kore|dao|daw)\b/.test(lower);
}

function isResetOnlySafetyBoundary(text) {
  const lower = String(text || '').toLowerCase();
  return (
    /\b(do not|don't|dont|never|not)\b[^.?!]{0,80}\breset\b/.test(lower) ||
    /\breset\b[^.?!]{0,80}\bwithout\s+asking\b/.test(lower)
  );
}

function hasRiskApproval(text) {
  return RISK_APPROVAL_RE.test(text) && /\b(reset|delete|remove|destroy|wipe|erase|clear|drop|truncate|publish|deploy)\b/i.test(text);
}

function isContinuationApproval(text) {
  const lower = normalize(text).toLowerCase();
  if (!lower) return false;
  if (hasExplicitActionIntent(lower) || isYoutubeMediaGoal(lower)) return false;
  const wordsOnly = lower.split(/\s+/).filter(Boolean);
  return wordsOnly.length <= 8 && RISK_APPROVAL_RE.test(lower);
}

function wpAdminContext(page) {
  const url = parseUrl(page.url || '');
  if (!url) return { url: null, base: '' };

  const marker = '/wp-admin/';
  const lowerPath = url.pathname.toLowerCase();
  const markerIndex = lowerPath.indexOf(marker);
  const prefix = markerIndex >= 0 ? url.pathname.slice(0, markerIndex) : '';
  return {
    url,
    base: `${url.origin}${prefix}${marker}`,
  };
}

function adminUrl(admin, relativePath) {
  return new URL(relativePath.replace(/^\/+/, ''), admin.base).toString();
}

function wpResetHref(page, actionPattern) {
  const clickables = Array.isArray(page.clickables) ? page.clickables : [];
  for (const item of clickables) {
    if (!isPlainObject(item)) continue;
    const href = String(item.href || '');
    const decoded = decodeURIComponent(href).toLowerCase();
    if (!href || !decoded.includes('wp-reset')) continue;
    if (!actionPattern.test(decoded)) continue;
    return href;
  }
  return '';
}

function isWpResetToolPage(page) {
  const url = String(page.url || '').toLowerCase();
  const text = normalize(String(page.visible_text || '')).toLowerCase();
  return url.includes('page=wp-reset') || (text.includes('wp reset') && text.includes('reset site'));
}

function wpResetConfirmField(page) {
  const forms = Array.isArray(page.forms) ? page.forms : [];
  let sawConfirmField = false;
  for (const form of forms) {
    if (!isPlainObject(form)) continue;
    const fields = Array.isArray(form.fields) ? form.fields : [];
    for (const field of fields) {
      if (!isPlainObject(field)) continue;
      const haystack = normalize([
        field.selector,
        field.name,
        field.placeholder,
        field.type,
      ].filter(Boolean).join(' ')).toLowerCase();
      if (!/\b(reset|confirm)\b/.test(haystack)) continue;
      sawConfirmField = true;
      if (Number(field.value_length || 0) > 0) continue;
      return field.ref || field.selector || '';
    }
  }

  return sawConfirmField ? '' : '#wp-reset-confirm,input[name="wp-reset-confirm"],input[name="wp_reset_confirm"],input[placeholder*="reset" i]';
}

function wpResetFinalButton(page) {
  const clickables = Array.isArray(page.clickables) ? page.clickables : [];
  const preferred = [
    'Yes, reset',
    'Yes, reset site',
    'Yes, reset WordPress',
    'Confirm reset',
    'Confirm',
    'OK',
    'Yes',
    'Reset Site',
    'Reset WordPress',
    'Reset site',
    'Reset WordPress site',
  ];

  for (const label of preferred) {
    const found = clickables.find((item) => isPlainObject(item) && normalize(item.text).toLowerCase() === label.toLowerCase());
    if (found) return found.ref || `text=${label}`;
  }

  const fuzzy = clickables.find((item) => {
    if (!isPlainObject(item)) return false;
    const text = normalize(item.text).toLowerCase();
    if (/^(ok|yes|confirm|yes, reset|confirm reset)$/.test(text)) return true;
    return text.includes('reset') && (text.includes('site') || text.includes('wordpress'));
  });
  if (fuzzy) return fuzzy.ref || `text=${normalize(fuzzy.text)}`;

  return 'text=Reset Site';
}

function isYoutubeMediaGoal(goal) {
  const lower = goal.toLowerCase();
  return lower.includes('youtube') || isPlaybackGoal(goal) || isSkipAdGoal(goal);
}

function isPlaybackGoal(goal) {
  return /\b(play|watch|song|songs|music|video|videos)\b/i.test(goal);
}

function isYoutubeUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const host = parsed.host.toLowerCase();
  return host === 'youtube.com' || host.endsWith('.youtube.com');
}

function queryMatchesPage(query, page) {
  const haystack = normalize([
    String(page.title || ''),
    String(page.visible_text || '').slice(0, 1600),
    String(page.url || ''),
  ].join(' ')).toLowerCase();
  const terms = words(query).filter((word) => !STOP_WORDS.has(word) && word.length > 2);
  if (!terms.length) return false;
  const score = terms.filter((term) => haystack.includes(term)).length;
  const threshold = terms.length === 1 ? 1 : Math.max(2, Math.min(terms.length, Math.round(terms.length * 0.6)));
  return score >= threshold;
}

function sameUrlWithoutHash(left, right) {
  const leftUrl = parseUrl(left);
  const rightUrl = parseUrl(right);
  if (!leftUrl || !rightUrl) return String(left || '') === String(right || '');
  leftUrl.hash = '';
  rightUrl.hash = '';
  return leftUrl.toString() === rightUrl.toString();
}

function firstYoutubeVideo(page, query = '') {
  const clickables = Array.isArray(page.clickables) ? page.clickables : [];
  const candidates = [];
  for (const item of clickables) {
    if (!isPlainObject(item)) continue;
    const href = String(item.href || '');
    const text = normalize(String(item.text || ''));
    if (!href.includes('/watch') || !text) continue;
    const fullHref = youtubeWatchHref(href);
    if (fullHref) candidates.push({ href: fullHref, text });
  }
  if (!candidates.length) return null;

  const queryTerms = words(query).filter((word) => !STOP_WORDS.has(word) && word.length > 2);
  if (!queryTerms.length) return candidates[0];

  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const haystack = `${candidate.text} ${candidate.href}`.toLowerCase();
    const score = queryTerms.filter((term) => haystack.includes(term)).length;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : candidates[0];
}

function youtubeWatchHref(href) {
  if (href.startsWith('/watch')) return `https://www.youtube.com${href}`;
  const parsed = parseUrl(href);
  if (parsed && isYoutubeUrl(href) && parsed.pathname.includes('/watch')) return href;
  return '';
}

function extractQuery(goal, extraStop = new Set()) {
  const stop = new Set([...STOP_WORDS, ...extraStop]);
  return words(goal)
    .filter((word) => !stop.has(word))
    .slice(0, 12)
    .join(' ')
    .trim();
}

function youtubeSearchUrl(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query).replace(/%20/g, '+')}`;
}

function words(text) {
  return String(text || '').match(/[a-z0-9+#.]+/gi)?.map((word) => word.toLowerCase()) || [];
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function pageEvidence(page) {
  const url = String(page.url || '').trim();
  const title = String(page.title || '').trim();
  if (url) {
    const parsed = parseUrl(url);
    const host = parsed?.host || url;
    return `Current page snapshot is "${title || host}" at ${host}.`;
  }
  return 'No inspectable page URL was supplied, so only the user goal was used.';
}

function takeReasoning(action) {
  const reasoning = action._reasoning || '';
  delete action._reasoning;
  return reasoning;
}

function dump(payload) {
  return JSON.stringify(payload);
}

function parseUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
