export function analyzeEmail({ subject = '', sender = '', body = '', snippet = '' }) {
  const content = `${subject} ${body} ${snippet}`.toLowerCase();
  
  let category = 'Other';
  let isActionRequired = false;
  let priorityScore = 10;
  let summary = snippet.slice(0, 180);

  // Categorization Rules
  if (/urgent|asap|emergency|immediate attention|critical|escalat/i.test(content)) {
    category = 'Urgent';
    priorityScore += 60;
    isActionRequired = true;
  } else if (/invoice|billing|receipt|payment|statement|due date|wire transfer/i.test(content)) {
    category = 'Finance';
    priorityScore += 30;
    if (/action required|past due|overdue|pay now/i.test(content)) isActionRequired = true;
  } else if (/invite|invitation|calendar|rescheduled|zoom\.us|meet\.google|teams\.microsoft/i.test(content)) {
    category = 'Meetings';
    priorityScore += 25;
  } else if (/status update|sprint|jira|pull request|deployment|blocker|roadmap/i.test(content)) {
    category = 'Work Updates';
    priorityScore += 20;
  } else if (/unsubscribe|view in browser|promotions|newsletter|digest|weekly round/i.test(content)) {
    category = 'Newsletters';
    priorityScore = 5;
  } else if (/please let me know|thoughts\?|can you|could you|action item|waiting on you/i.test(content)) {
    category = 'Requires Reply';
    isActionRequired = true;
    priorityScore += 40;
  } else if (/following up|checking in|circling back|bump/i.test(content)) {
    category = 'Follow-Up Needed';
    priorityScore += 30;
  }

  // Refined priority adjustments
  if (isActionRequired) priorityScore += 20;
  if (priorityScore > 100) priorityScore = 100;

  // Executive summary generation
  if (category === 'Urgent') {
    summary = `[URGENT] High-priority communication requiring immediate executive review: "${subject}"`;
  } else if (category === 'Finance') {
    summary = `Financial notice or transaction details detected from ${sender}.`;
  } else if (category === 'Meetings') {
    summary = `Meeting coordinate or scheduling request: "${subject}"`;
  } else if (category === 'Requires Reply') {
    summary = `Response/decision requested from ${sender}.`;
  }

  return {
    category,
    isActionRequired,
    priorityScore,
    summary: summary || snippet
  };
}
