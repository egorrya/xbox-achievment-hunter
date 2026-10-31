// The same setup panel is used inline for a new queue and inside the queue editor.
export function setReferenceStep(elements, {review, dialogOpen, hasEntries, canUpdate}) {
  elements.input.hidden = review;
  elements.review.hidden = !review;
  elements.dialogBack.hidden = !review;
  elements.dialogNext.hidden = review;
  elements.dialogNext.disabled = !hasEntries;
  elements.inlineBack.hidden = dialogOpen || !review;
  elements.inlineNext.hidden = dialogOpen || review || !hasEntries;
  elements.hint.textContent = 'Only paused queues can be updated.';
  elements.hint.hidden = !dialogOpen || !review || canUpdate;
}
