/** PCM ring layout and writer authority belongs to the Engine SDK. */
export {
  MSB1_MAGIC, MSB1_VERSION, MSB1_WRAP, MSB1_CONTROL_BYTES, MSB1_CONTROL_I64_OFFSET,
  MSB1_ID_OFFSET, MSB1_ID_CAPACITY, MSB1_HEADER_OFFSET, MSB1_SLOT_HEADER_BYTES,
  MSB1_FLAG_END_OF_REGION, MSB1_CONTROL, msb1RingBytes, createMsb1Ring, Msb1RingWriter,
} from "@misofm/engine/browser";
export type { Msb1RingLayout, Msb1RingCounters } from "@misofm/engine/browser";
