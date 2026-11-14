/** Shared Node business kernel. No Host, HTTP, tenant identity or model credentials. */
import { createManagerService } from './manager.js';
import * as documents from './artifacts.js';
import * as reviews from './reviews.js';
import * as knowledge from './knowledge.js';
import * as learning from './learning.js';
import * as plans from './learning-plan.js';
import * as coaching from './learning-coach.js';
import * as memory from './learning-memory.js';
import * as schedules from './learning-review.js';
export { createManagerService } from './manager.js';
export { createProjectState, boardSummary } from './project-state.js';
export { documents, reviews, knowledge, learning, plans, coaching, memory, schedules };
export const CORE_VERSION = '1.0.0';
/** Host and product API supply execution, locking, board persistence and packaging ports. */
export function createProjectServices(ports) {
  return Object.freeze({version:CORE_VERSION, tasks:createManagerService(ports), documents, reviews,
    knowledge, learning:Object.freeze({...learning,...plans,...coaching,...memory,...schedules})});
}
export { assertCurrentDocument, assertDocumentHashes } from './document-policy.js';
export { persistBoardRecord } from './board-records.js';
