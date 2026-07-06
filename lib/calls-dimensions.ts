// lib/calls-dimensions.ts
//
// Shared labels for coaching dimensions and call types. Dimension sets vary
// per call type since the v4 rubric (coaching_rubrics.call_types), so UI code
// must NEVER hardcode dimension keys — render whatever keys the analysis
// carries and label them here (unknown keys prettify automatically, so adding
// a dimension to the rubric needs no deploy).

const DIMENSION_LABELS: Record<string, string> = {
  // v3 / new_sales_enquiry
  discovery: 'Discovery',
  product_knowledge: 'Product Knowledge',
  objection_handling: 'Objection Handling',
  closing: 'Closing',
  rapport: 'Rapport',
  consultative_technique: 'Consultative Technique',
  // quote_follow_up
  context_recap: 'Context & Recap',
  value_reinforcement: 'Value Reinforcement',
  // booking_scheduling
  efficiency_clarity: 'Efficiency & Clarity',
  details_captured: 'Details Captured',
  expectation_setting: 'Expectation Setting',
  opportunity_awareness: 'Opportunity Awareness',
  // status_support
  ownership: 'Ownership',
  clarity_honesty: 'Clarity & Honesty',
  empathy: 'Empathy',
  resolution_next_step: 'Resolution & Next Step',
}

export function dimensionLabel(key: string): string {
  return DIMENSION_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export const CALL_TYPE_LABELS: Record<string, string> = {
  new_sales_enquiry: 'New enquiry',
  quote_follow_up: 'Quote follow-up',
  booking_scheduling: 'Booking / scheduling',
  status_support: 'Status / support',
  not_coachable: 'Not coachable',
}

export function callTypeLabel(key: string | null | undefined): string | null {
  if (!key) return null
  return CALL_TYPE_LABELS[key] || key.replace(/_/g, ' ')
}
