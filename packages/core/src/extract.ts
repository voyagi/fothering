import { UNCLASSIFIED } from './records.js';

// RED stub: every extractor returns unclassified (or absent for tagValue) so the test file loads
// and its real assertions run and fail, instead of the whole suite crashing on a missing module.
export function extractEnhancedStatusCode(_text: string): string {
  return UNCLASSIFIED;
}
export function extractBasicReplyCode(_text: string): string {
  return UNCLASSIFIED;
}
export function validIp(_value: string): string {
  return UNCLASSIFIED;
}
export function validHostname(_value: string): string {
  return UNCLASSIFIED;
}
export function reportingMta(_value: string): string {
  return UNCLASSIFIED;
}
export function callerIdentity(_value: string): string {
  return UNCLASSIFIED;
}
export function recipientStatus(_value: string): string {
  return UNCLASSIFIED;
}
export function recipientAction(_value: string): string {
  return UNCLASSIFIED;
}
export function tagValue(_value: string): string | undefined {
  return undefined;
}
