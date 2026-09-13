const briefingTopics = {
  compute: {
    label: 'Compute & chips', title: 'Follow the capacity behind the capability.',
    summary: 'A model announcement is only part of the story. Our compute coverage connects chip supply, advanced packaging, and datacenter expansion.',
    watch: 'GPU supply · Foundry capacity · Cloud buildouts',
    question: 'Does new capacity translate into sustained demand?',
    sources: 'Company filings + industry reporting',
  },
  power: {
    label: 'Power & cooling', title: 'The next constraint may be the grid.',
    summary: 'AI needs more than silicon. Follow the power agreements, grid connections, and cooling systems that determine where compute can grow.',
    watch: 'Grid capacity · Power agreements · Liquid cooling',
    question: 'Can power and cooling arrive when the compute does?',
    sources: 'Utility coverage + infrastructure reporting',
  },
  capital: {
    label: 'Capital & markets', title: 'Read the commitments behind the headlines.',
    summary: 'Separate announced ambition from committed spending. Track company filings, capital expenditure, and earnings guidance across the AI value chain.',
    watch: 'Capital expenditure · Earnings guidance · Market context',
    question: 'What has been committed, and what is still a forecast?',
    sources: 'SEC filings + company earnings',
  },
};

const briefingTabs = [...document.querySelectorAll('[data-briefing-topic]')];
function selectBriefingTopic(tab, moveFocus = false) {
  const topic = briefingTopics[tab.dataset.briefingTopic];
  briefingTabs.forEach(button => {
    const selected = button === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.getElementById('briefingPanel').setAttribute('aria-labelledby', tab.id);
  for (const field of ['label', 'title', 'summary', 'watch', 'question', 'sources']) {
    document.getElementById('briefing-' + field).textContent = topic[field];
  }
  if (moveFocus) tab.focus();
}

briefingTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectBriefingTopic(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % briefingTabs.length;
    if (event.key === 'ArrowLeft') next = (index + briefingTabs.length - 1) % briefingTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = briefingTabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectBriefingTopic(briefingTabs[next], true);
  });
});
