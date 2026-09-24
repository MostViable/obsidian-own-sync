import { MAX_PACKET_BYTES } from './packet.ts';

export function assertCompatibleCapabilities(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Server did not report protocol capabilities.');
  }
  const capabilities = value as Record<string, unknown>;
  const maxPacketBytes = capabilities.max_packet_bytes;
  if (capabilities.protocol_version !== 0 || capabilities.packet_format_version !== 1 ||
    typeof maxPacketBytes !== 'number' || !Number.isSafeInteger(maxPacketBytes) ||
    maxPacketBytes < MAX_PACKET_BYTES) {
    throw new Error('Server protocol or packet limit is incompatible with this plugin.');
  }
}
