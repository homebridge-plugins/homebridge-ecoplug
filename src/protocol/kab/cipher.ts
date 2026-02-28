/**
 * KABNetManager native encryption routines, reverse-engineered from
 * libnative-lib.so (x86_64) symbols at:
 *
 *   0x173d0  Java_…_CPPtoBytesEncryption              TX: encrypts outgoing commands
 *   0x17480  Java_…_CPPParseBytesEncryption            RX: decrypts command responses
 *   0x17570  Java_…_CPPParseBytesBroadcastEncryption   RX: decrypts beacon packets
 *   0x17670  Java_…_CPPCheckSum                        validates checksums
 *
 * All three ciphers are XOR stream ciphers operating on different byte
 * ranges, with different counter strides determined by the native code.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * CPPtoBytesEncryption  (0x173d0)
 *   Modifies buf[16..71] IN‑PLACE.
 *   Key bytes k0‑k3 = buf[0..3] (the timeMark field BE bytes).
 *   14 iterations, 4 bytes each = bytes 16‥71.
 *   Counter strides per byte lane: +9, +13, +17, +19.
 *   Applied BEFORE writing p/q/r (subtype + payload) at offset 76+.
 *
 * CPPParseBytesEncryption  (0x17480)
 *   src → dst, decrypts src[56..71] (4 work iterations @ rsi=10‥13).
 *   Key bytes = src[0..3].
 *   Counter strides: +18, +8, +9, +13 (counter starts at rsi=0 counting
 *   to 13, work only when rsi>=10).
 *
 * CPPParseBytesBroadcastEncryption  (0x17570)
 *   src → dst, decrypts beacon src[20..267] (excluding 236‥239 which
 *   are the key bytes themselves and are copied as-is).
 *   Key bytes = src[236..239].
 *   rdx strides: +4; counter strides: cl +2, al +3, bpl +1.
 *   dl is the low byte of rdx (= 4 × iteration_count mod 256).
 *
 * CPPCheckSum  (0x17670)
 *   Simple 32-bit sum of all bytes in the array, returned as int.
 */

/**
 * Encrypt a 152-byte outgoing KAB command buffer in‑place.
 *
 * Operates on bytes [16..71] using bytes [0..3] as the key seed plus
 * arithmetically progressing counter values.
 */
export function cppToBytesEncryption(buf: Buffer): void {
    const k0 = buf[0], k1 = buf[1], k2 = buf[2], k3 = buf[3];
    let d = 0, c = 0, di = 0, r12 = 0;
    // 14 iterations, 4 bytes per iteration → bytes 16‥71
    for (let i = 0; i < 14; i++) {
        const base = 16 + i * 4;
        // counters are applied BEFORE incrementing (value used is the value at the START of this iteration)
        buf[base]     = (buf[base]     ^ d   ^ k0) & 0xff;
        buf[base + 1] = (buf[base + 1] ^ c   ^ k1) & 0xff;
        buf[base + 2] = (buf[base + 2] ^ di  ^ k2) & 0xff;
        buf[base + 3] = (buf[base + 3] ^ r12 ^ k3) & 0xff;
        d   = (d   + 9)  & 0xff;
        c   = (c   + 13) & 0xff;
        di  = (di  + 17) & 0xff;
        r12 = (r12 + 19) & 0xff;
    }
}

/**
 * Decrypt a KAB command response packet (src → dst).
 *
 * Decrypts bytes [56..71] only; the rest of src is copied as-is.
 * Key bytes = src[0..3].
 */
export function cppParseBytesEncryption(src: Buffer, dst: Buffer): void {
    // Copy everything first, then overwrite the decrypted range.
    src.copy(dst, 0, 0, Math.min(src.length, dst.length));

    const k0 = src[0], k1 = src[1], k2 = src[2], k3 = src[3];

    // The native loop runs rsi = 0..13, but only does work when (rsi - 7) >= 3
    // i.e. rsi >= 10.  Counters are incremented every iteration regardless.
    let dl = 0, cl = 0, al = 0, bpl = 0;
    for (let rsi = 0; rsi <= 13; rsi++) {
        if (rsi >= 10) {
            const base = 16 + rsi * 4;
            dst[base]     = (src[base]     ^ dl  ^ k0) & 0xff;
            dst[base + 1] = (src[base + 1] ^ cl  ^ k1) & 0xff;
            dst[base + 2] = (src[base + 2] ^ al  ^ k2) & 0xff;
            dst[base + 3] = (src[base + 3] ^ bpl ^ k3) & 0xff;
        }
        // Counters increment after potential work (at 0x174d0 in the native code)
        dl  = (dl  + 0x12) & 0xff;
        cl  = (cl  + 0x08) & 0xff;
        al  = (al  + 0x09) & 0xff;
        bpl = (bpl + 0x0d) & 0xff;
    }
}

/**
 * Decrypt a KAB beacon broadcast packet (src → dst).
 *
 * Decrypts beacon bytes [20..267] using the 4-byte key embedded at
 * src[236..239].  Bytes 236‥239 are copied as-is (they ARE the key).
 * All other bytes (0‥19 and 268+) are also copied unchanged.
 *
 * @param src  Raw encrypted beacon packet (minimum 272 bytes).
 * @param dst  Output buffer of the same size as src.
 */
export function cppParseBytesBroadcastEncryption(src: Buffer, dst: Buffer): void {
    // Copy everything first; we'll overwrite the decrypted ranges below.
    src.copy(dst, 0, 0, Math.min(src.length, dst.length));

    const k0 = src[0xec]; // src[236]
    const k1 = src[0xed]; // src[237]
    const k2 = src[0xee]; // src[238]
    const k3 = src[0xef]; // src[239]

    // Native loop: rdx starts 0, increments by 4 each step, exits when rdx == 0xf8 (248).
    // When rdx == 0xd8 (216), skip decrypt but still increment counters.
    // Entry into loop body is via jmp to the CHECK at 0x175d6 (no pre-increment on first iteration).
    let cl = 0, al = 0, bpl = 0;
    for (let rdx = 0; rdx < 0xf8; rdx += 4) {
        // cl, al, bpl are the counter values BEFORE incrementing for this iteration
        if (rdx !== 0xd8) {
            const base = rdx + 20;
            const dl = rdx & 0xff; // dl is the low byte of rdx
            dst[base]     = (src[base]     ^ cl  ^ k0) & 0xff;
            dst[base + 1] = (src[base + 1] ^ dl  ^ k1) & 0xff;
            dst[base + 2] = (src[base + 2] ^ al  ^ k2) & 0xff;
            dst[base + 3] = (src[base + 3] ^ bpl ^ k3) & 0xff;
        }
        // Counters increment after EVERY step (including the skip at rdx=0xd8)
        cl  = (cl  + 2) & 0xff;
        al  = (al  + 3) & 0xff;
        bpl = (bpl + 1) & 0xff;
    }
    // Bytes 236..239 were skipped in the decrypt loop (they are the key).
    // They were already copied in the initial src.copy(), so nothing extra needed.
}

/**
 * Compute the KAB checksum: simple 32-bit sum of all bytes, truncated to 32 bits
 * then returned as a JS number (may be > 0x7fffffff — treated as unsigned).
 */
export function cppCheckSum(buf: Buffer): number {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
        sum = (sum + buf[i]) >>> 0; // keep unsigned 32-bit
    }
    return sum;
}
