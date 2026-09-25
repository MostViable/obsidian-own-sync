import { MAX_DECODED_PACKET_BYTES } from './packet.ts';

const MIN_PACKET_BYTES = 128 * 1024;

// Returns the upload packet limit this plugin will use with the server.
export function packetLimitFromCapabilities(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Server did not report protocol capabilities.');
  }
  const capabilities = value as Record<string, unknown>;
  const maxPacketBytes = capabilities.max_packet_bytes;
  if (capabilities.protocol_version !== 0 || capabilities.packet_format_version !== 1 ||
    typeof maxPacketBytes !== 'number' || !Number.isSafeInteger(maxPacketBytes) ||
    maxPacketBytes < MIN_PACKET_BYTES) {
    throw new Error('Server protocol or packet limit is incompatible with this plugin.');
  }
  return Math.min(maxPacketBytes, MAX_DECODED_PACKET_BYTES);
}
