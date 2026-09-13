#include <stdint.h>

#if SHA256_SIMD
#include <wasm_simd128.h>
#endif

static const uint32_t ROUND[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

static inline uint32_t rotate_right(uint32_t value, unsigned count) {
    return (value >> count) | (value << (32U - count));
}

static inline uint32_t load_be32(const uint8_t *input) {
    return ((uint32_t)input[0] << 24) |
           ((uint32_t)input[1] << 16) |
           ((uint32_t)input[2] << 8) |
           (uint32_t)input[3];
}

static inline void load_first_words(const uint8_t *input, uint32_t *words) {
#if SHA256_SIMD
    /* Four independent big-endian words are the only SIMD refinement. */
    const v128_t bytes = wasm_v128_load(input);
    const v128_t swapped = wasm_i8x16_shuffle(
        bytes, bytes,
        3, 2, 1, 0,
        7, 6, 5, 4,
        11, 10, 9, 8,
        15, 14, 13, 12);
    wasm_v128_store(words, swapped);
    input += 16;
    words += 4;
    for (unsigned index = 0; index < 3; index += 1) {
        const v128_t raw = wasm_v128_load(input);
        const v128_t next = wasm_i8x16_shuffle(
            raw, raw,
            3, 2, 1, 0,
            7, 6, 5, 4,
            11, 10, 9, 8,
            15, 14, 13, 12);
        wasm_v128_store(words, next);
        input += 16;
        words += 4;
    }
#else
    for (unsigned index = 0; index < 16; index += 1) {
        words[index] = load_be32(input + index * 4);
    }
#endif
}

void sha256_compress(uint32_t *state, const uint8_t *blocks, uint32_t block_count) {
    uint32_t words[64];
    for (uint32_t block = 0; block < block_count; block += 1) {
        load_first_words(blocks, words);
        for (unsigned index = 16; index < 64; index += 1) {
            const uint32_t before15 = words[index - 15];
            const uint32_t before2 = words[index - 2];
            const uint32_t sigma0 = rotate_right(before15, 7) ^
                                     rotate_right(before15, 18) ^
                                     (before15 >> 3);
            const uint32_t sigma1 = rotate_right(before2, 17) ^
                                     rotate_right(before2, 19) ^
                                     (before2 >> 10);
            words[index] = words[index - 16] + sigma0 + words[index - 7] + sigma1;
        }

        uint32_t a = state[0];
        uint32_t b = state[1];
        uint32_t c = state[2];
        uint32_t d = state[3];
        uint32_t e = state[4];
        uint32_t f = state[5];
        uint32_t g = state[6];
        uint32_t h = state[7];
        for (unsigned index = 0; index < 64; index += 1) {
            const uint32_t sum1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
            const uint32_t choose = (e & f) ^ ((~e) & g);
            const uint32_t temporary1 = h + sum1 + choose + ROUND[index] + words[index];
            const uint32_t sum0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
            const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t temporary2 = sum0 + majority;
            h = g;
            g = f;
            f = e;
            e = d + temporary1;
            d = c;
            c = b;
            b = a;
            a = temporary1 + temporary2;
        }
        state[0] += a;
        state[1] += b;
        state[2] += c;
        state[3] += d;
        state[4] += e;
        state[5] += f;
        state[6] += g;
        state[7] += h;
        blocks += 64;
    }
}
