/*
 * Issue #77 round 1: public libFLAC residual extraction and independent
 * diagnostic-record reconstruction.  This file is intentionally standalone;
 * it is linked only with the pinned libFLAC static archive by the runner.
 */
#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L
#include <FLAC/format.h>
#include <FLAC/stream_decoder.h>

#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>

#define MAGIC "I77RSD01"
#define MAX_BLOCK 65535u
#define MAX_RECORD (1024u * 1024u)
#define MAX_CHANNELS 8u
#define MAX_LPC FLAC__MAX_LPC_ORDER
#define MAX_PARTITION FLAC__MAX_RICE_PARTITION_ORDER
#define LAG_COUNT 6u

typedef struct {
    uint64_t type_counts[4];
    uint64_t order_counts[33];
    uint64_t assignment_counts[4];
    uint64_t method_counts[2];
    uint64_t k_counts[32];
    uint64_t residual_samples;
    uint64_t ordinary_samples;
    uint64_t escaped_partitions;
    uint64_t escaped_samples;
    uint64_t subframes;
    uint64_t ordinary_subframes;
    uint64_t subframe_header_bits;
    uint64_t wasted_bits;
    uint64_t warmup_bits;
    uint64_t coefficient_bits;
    uint64_t constant_bits;
    uint64_t verbatim_bits;
    uint64_t residual_header_bits;
    uint64_t quotient_bits;
    uint64_t remainder_bits;
    uint64_t escaped_raw_bits;
    uint64_t frame_header_bits;
    uint64_t frame_crc_bits;
    uint64_t frame_padding_bits;
    uint64_t frame_bytes;
    uint64_t frame_count;
    uint64_t qhist[4][32][17];
    uint64_t conthist[4][32][5][17];
    uint64_t remhist[4][32][31][2];
    double residual_sum;
    double residual_sum_sq;
    uint64_t lag_counts[LAG_COUNT];
    double lag_corr_sum[LAG_COUNT];
} Stats;

typedef struct {
    FILE *records;
    FILE *summary;
    uint32_t chunk_index;
    uint64_t packed_base;
    uint64_t metadata_end;
    uint64_t previous_end;
    uint64_t record_count;
    uint64_t frame_count;
    uint64_t pcm_samples;
    uint64_t copied_bytes;
    FILE *headers;
    Stats stats;
    int error;
    int saw_metadata;
    int saw_streaminfo;
    FLAC__uint64 last_position;
} ExtractContext;

typedef struct {
    FILE *out;
    uint64_t record_count;
    uint64_t frame_count;
    uint64_t pcm_samples;
    uint64_t previous_packed;
    uint64_t previous_offset;
    uint32_t previous_blocksize;
    uint32_t previous_chunk;
    int has_previous;
    int error;
} DecodeContext;

static void failf(const char *message) {
    fprintf(stderr, "round1: %s\n", message);
}

static int write_bytes(FILE *f, const void *data, size_t size) {
    return size == 0 || fwrite(data, 1, size, f) == size;
}

static int read_bytes(FILE *f, void *data, size_t size) {
    return size == 0 || fread(data, 1, size, f) == size;
}

static int put_u8(FILE *f, uint8_t v) { return write_bytes(f, &v, 1); }

static int put_u16(FILE *f, uint16_t v) {
    uint8_t b[2] = {(uint8_t)v, (uint8_t)(v >> 8)};
    return write_bytes(f, b, sizeof b);
}

static int put_u32(FILE *f, uint32_t v) {
    uint8_t b[4] = {(uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16),
                    (uint8_t)(v >> 24)};
    return write_bytes(f, b, sizeof b);
}

static int put_u64(FILE *f, uint64_t v) {
    uint8_t b[8];
    for (unsigned i = 0; i < 8; ++i) b[i] = (uint8_t)(v >> (8u * i));
    return write_bytes(f, b, sizeof b);
}

static int put_i32(FILE *f, int32_t v) { return put_u32(f, (uint32_t)v); }

static int get_u8(FILE *f, uint8_t *v) { return read_bytes(f, v, 1); }

static int get_u16(FILE *f, uint16_t *v) {
    uint8_t b[2];
    if (!read_bytes(f, b, sizeof b)) return 0;
    *v = (uint16_t)b[0] | ((uint16_t)b[1] << 8);
    return 1;
}

static int get_u32(FILE *f, uint32_t *v) {
    uint8_t b[4];
    if (!read_bytes(f, b, sizeof b)) return 0;
    *v = (uint32_t)b[0] | ((uint32_t)b[1] << 8) |
         ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
    return 1;
}

static int get_u64(FILE *f, uint64_t *v) {
    uint8_t b[8];
    if (!read_bytes(f, b, sizeof b)) return 0;
    *v = 0;
    for (unsigned i = 0; i < 8; ++i) *v |= (uint64_t)b[i] << (8u * i);
    return 1;
}

static int get_i32(FILE *f, int32_t *v) {
    uint32_t x;
    if (!get_u32(f, &x)) return 0;
    *v = (int32_t)x;
    return 1;
}

static int checked_i64(__int128 value, int64_t *out) {
    if (value < INT64_MIN || value > INT64_MAX) return 0;
    *out = (int64_t)value;
    return 1;
}

/* FLAC's LPC shift is an arithmetic right shift (floor for negative values).
 * Keep it explicit so this diagnostic does not depend on implementation-defined
 * signed shifts or overflow. */
static int floor_pow2_shift(__int128 value, int shift, __int128 *out) {
    if (shift >= 0) {
        if (shift >= 127) {
            if (value == 0) *out = 0;
            else return 0;
            return 1;
        }
        __int128 divisor = ((__int128)1) << shift;
        if (value >= 0) *out = value / divisor;
        else *out = -(((-value) + divisor - 1) / divisor);
        return 1;
    }
    unsigned left = (unsigned)(-shift);
    if (left >= 127) return value == 0 ? (*out = 0, 1) : 0;
    int64_t scaled;
    if (!checked_i64(value * (((__int128)1) << left), &scaled)) return 0;
    *out = scaled;
    return 1;
}

static int subframe_role(FLAC__ChannelAssignment assignment, unsigned channel,
                         unsigned channels, unsigned *role) {
    if (channels != 2 || channel >= 2) return 0;
    switch (assignment) {
        case FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT:
            *role = channel; /* left, right */
            return 1;
        case FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE:
            *role = channel == 0 ? 0u : 3u; /* left, side */
            return 1;
        case FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE:
            *role = channel == 0 ? 3u : 1u; /* side, right */
            return 1;
        case FLAC__CHANNEL_ASSIGNMENT_MID_SIDE:
            *role = channel == 0 ? 2u : 3u; /* mid, side */
            return 1;
        default:
            return 0;
    }
}

static int stats_subframe(Stats *stats, const FLAC__Frame *frame, unsigned channel) {
    const FLAC__Subframe *sub = &frame->subframes[channel];
    unsigned role;
    if (!subframe_role(frame->header.channel_assignment, channel, frame->header.channels, &role) || role >= 4)
        return 0;
    if (sub->type > FLAC__SUBFRAME_TYPE_LPC || sub->wasted_bits >= 32) return 0;
    uint32_t n = frame->header.blocksize;
    uint32_t order = 0, precision = 0;
    int shift = 0;
    const FLAC__int32 *residual = NULL;
    const FLAC__EntropyCodingMethod *entropy = NULL;
    stats->type_counts[sub->type]++;
    stats->subframes++;
    stats->subframe_header_bits += 8;
    stats->wasted_bits += sub->wasted_bits;
    switch (sub->type) {
        case FLAC__SUBFRAME_TYPE_CONSTANT:
            stats->constant_bits += frame->header.bits_per_sample +
                (((frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE && channel == 1) ||
                  (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE && channel == 0) ||
                  (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_MID_SIDE && channel == 1)) ? 1u : 0u) -
                sub->wasted_bits;
            return 1;
        case FLAC__SUBFRAME_TYPE_VERBATIM:
            stats->verbatim_bits += (uint64_t)n *
                (frame->header.bits_per_sample +
                 (((frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE && channel == 1) ||
                   (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE && channel == 0) ||
                   (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_MID_SIDE && channel == 1)) ? 1u : 0u) -
                sub->wasted_bits);
            return 1;
        case FLAC__SUBFRAME_TYPE_FIXED:
            order = sub->data.fixed.order;
            residual = sub->data.fixed.residual;
            entropy = &sub->data.fixed.entropy_coding_method;
            break;
        case FLAC__SUBFRAME_TYPE_LPC:
            order = sub->data.lpc.order;
            precision = sub->data.lpc.qlp_coeff_precision;
            shift = sub->data.lpc.quantization_level;
            residual = sub->data.lpc.residual;
            entropy = &sub->data.lpc.entropy_coding_method;
            break;
        default:
            return 0;
    }
    if (!residual || !entropy || order > n || order > MAX_LPC || order > 32 ||
        (sub->type == FLAC__SUBFRAME_TYPE_LPC &&
         (precision < FLAC__MIN_QLP_COEFF_PRECISION || precision > FLAC__MAX_QLP_COEFF_PRECISION ||
          shift < -16 || shift > 15))) return 0;
    stats->order_counts[order]++;
    stats->warmup_bits += (uint64_t)order *
        (frame->header.bits_per_sample +
         (((frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE && channel == 1) ||
           (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE && channel == 0) ||
           (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_MID_SIDE && channel == 1)) ? 1u : 0u) -
        sub->wasted_bits);
    if (sub->type == FLAC__SUBFRAME_TYPE_LPC)
        stats->coefficient_bits += 4u + 5u + (uint64_t)order * precision;
    stats->residual_header_bits += 2u + 4u;
    stats->method_counts[entropy->type]++;
    uint32_t partition_order = entropy->data.partitioned_rice.order;
    if (partition_order > MAX_PARTITION || partition_order > 15) return 0;
    uint32_t partitions = 1u << partition_order;
    uint32_t partition_size = n >> partition_order;
    if (!partition_size || partition_size < order) return 0;
    uint32_t index = 0;
    double local_sum = 0.0, local_sum_sq = 0.0;
    unsigned parameter_width = entropy->type == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE ? 4u : 5u;
    unsigned escape = entropy->type == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                          ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                          : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
    int has_ordinary = 0;
    for (uint32_t p = 0; p < partitions; ++p) {
        uint32_t count = partition_size - (p == 0 ? order : 0);
        uint32_t parameter = entropy->data.partitioned_rice.contents->parameters[p];
        uint32_t raw_width = entropy->data.partitioned_rice.contents->raw_bits[p];
        if (parameter >= (1u << parameter_width) ||
            (parameter == escape ? raw_width > 31 : raw_width != 0) ||
            index + count > n - order) return 0;
        stats->residual_header_bits += parameter_width;
        if (parameter == escape) {
            stats->escaped_partitions++;
            stats->escaped_samples += count;
            stats->residual_header_bits += 5u;
            stats->escaped_raw_bits += (uint64_t)count * raw_width;
        } else {
            has_ordinary = 1;
            stats->ordinary_samples += count;
            stats->k_counts[parameter] += count;
        }
        uint32_t previous_class = 4;
        for (uint32_t j = 0; j < count; ++j) {
            int64_t r = residual[index + j];
            uint64_t u = r >= 0 ? (uint64_t)r * 2u : (uint64_t)(-2 * (int64_t)r - 1);
            local_sum += (double)r;
            local_sum_sq += (double)r * (double)r;
            stats->residual_sum += (double)r;
            stats->residual_sum_sq += (double)r * (double)r;
            if (parameter == escape) continue;
            uint64_t q = u >> parameter;
            uint32_t symbol = q > 16 ? 16u : (uint32_t)q;
            stats->qhist[role][parameter][symbol]++;
            stats->conthist[role][parameter][previous_class][symbol]++;
            previous_class = q > 3 ? 3u : (uint32_t)q;
            stats->quotient_bits += q + 1u;
            stats->remainder_bits += parameter;
            for (uint32_t bit = 0; bit < parameter; ++bit)
                stats->remhist[role][parameter][bit][(u >> bit) & 1u]++;
        }
        index += count;
    }
    if (index != n - order) return 0;
    uint64_t residual_count = n - order;
    stats->residual_samples += residual_count;
    if (has_ordinary) stats->ordinary_subframes++;
    if (residual_count) {
        double mean = local_sum / (double)residual_count;
        double variance = local_sum_sq - (double)residual_count * mean * mean;
        if (variance > 0.0) {
            const unsigned lags[LAG_COUNT] = {1, 2, 4, 8, 16, 32};
            for (unsigned li = 0; li < LAG_COUNT; ++li) {
                unsigned lag = lags[li];
                if (lag >= residual_count) continue;
                double covariance = 0.0;
                for (uint32_t i = lag; i < residual_count; ++i)
                    covariance += ((double)residual[i] - mean) * ((double)residual[i - lag] - mean);
                stats->lag_counts[li]++;
                stats->lag_corr_sum[li] += covariance / variance;
            }
        }
    }
    return 1;
}

static int stats_frame(Stats *stats, const FLAC__Frame *frame) {
    if (frame->header.channels != 2 || frame->header.channel_assignment > FLAC__CHANNEL_ASSIGNMENT_MID_SIDE)
        return 0;
    stats->assignment_counts[frame->header.channel_assignment]++;
    for (unsigned channel = 0; channel < frame->header.channels; ++channel)
        if (!stats_subframe(stats, frame, channel)) return 0;
    return 1;
}

static uint64_t stats_audio_bits(const Stats *stats) {
    return stats->subframe_header_bits + stats->wasted_bits + stats->warmup_bits +
           stats->coefficient_bits + stats->constant_bits + stats->verbatim_bits +
           stats->residual_header_bits + stats->quotient_bits + stats->remainder_bits +
           stats->escaped_raw_bits;
}

static int parse_frame_header(FILE *f, uint64_t offset, uint32_t expected_block,
                              uint8_t expected_assignment, uint32_t *header_bytes) {
    uint8_t b[32] = {0};
    if (fseeko(f, (off_t)offset, SEEK_SET) != 0 || fread(b, 1, 4, f) != 4 ||
        b[0] != 0xff || (b[1] & 0xfc) != 0xf8 || (b[3] & 1) != 0) return 0;
    unsigned assignment_code = b[3] >> 4;
    unsigned parsed_assignment = assignment_code <= 7 ? FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT :
                                  assignment_code == 8 ? FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE :
                                  assignment_code == 9 ? FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE :
                                  assignment_code == 10 ? FLAC__CHANNEL_ASSIGNMENT_MID_SIDE : 255;
    if (parsed_assignment != expected_assignment) return 0;
    unsigned block_code = b[2] >> 4;
    unsigned rate_code = b[2] & 15u;
    size_t pos = 4;
    /* UTF-8 coded frame/sample number follows the four fixed header bytes. */
    if (fread(b + pos, 1, 1, f) != 1) return 0;
    uint8_t number_first = b[pos++];
    unsigned number_bytes = 1;
    if (number_first & 0x80) {
        number_bytes = 0;
        uint8_t mask = 0x80;
        while (number_first & mask) { number_bytes++; mask >>= 1; }
        if (number_bytes < 2 || number_bytes > 7) return 0;
        for (unsigned i = 1; i < number_bytes; ++i) {
            if (pos >= sizeof b || fread(b + pos, 1, 1, f) != 1 ||
                (b[pos] & 0xc0) != 0x80) return 0;
            pos++;
        }
    }
    uint32_t block = 0;
    switch (block_code) {
        case 0: block = expected_block; break;
        case 1: block = 192; break;
        case 2: case 3: case 4: case 5: block = 576u << (block_code - 2); break;
        case 6:
            if (fread(b + pos, 1, 1, f) != 1) return 0;
            block = b[pos++] + 1u;
            break;
        case 7:
            if (fread(b + pos, 1, 2, f) != 2) return 0;
            block = ((uint32_t)b[pos] << 8) | b[pos + 1];
            block++;
            pos += 2;
            break;
        default:
            block = 256u << (block_code - 8);
            break;
    }
    switch (rate_code) {
        case 12: if (fread(b + pos, 1, 1, f) != 1) return 0; pos += 1; break;
        case 13: case 14: if (fread(b + pos, 1, 2, f) != 2) return 0; pos += 2; break;
        case 15: return 0;
        default: break;
    }
    if (pos >= sizeof b || block != expected_block) return 0;
    if (fread(b + pos, 1, 1, f) != 1) return 0;
    *header_bytes = (uint32_t)(pos + 1);
    return 1;
}

static int restore_subframe(const FLAC__Frame *frame, unsigned channel,
                            const FLAC__int32 *decoded, int64_t *values) {
    const FLAC__Subframe *sub = &frame->subframes[channel];
    uint32_t n = frame->header.blocksize;
    uint32_t order = 0;
    uint32_t wasted = sub->wasted_bits;
    if (wasted >= frame->header.bits_per_sample +
                     ((frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE && channel == 1) ||
                      (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE && channel == 0) ||
                      (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_MID_SIDE && channel == 1)))
        return 0;

    switch (sub->type) {
        case FLAC__SUBFRAME_TYPE_CONSTANT: {
            int64_t value = sub->data.constant.value;
            for (uint32_t i = 0; i < n; ++i) values[i] = value;
            order = 0;
            break;
        }
        case FLAC__SUBFRAME_TYPE_VERBATIM:
            for (uint32_t i = 0; i < n; ++i) {
                values[i] = sub->data.verbatim.data_type == FLAC__VERBATIM_SUBFRAME_DATA_TYPE_INT32
                                ? sub->data.verbatim.data.int32[i]
                                : sub->data.verbatim.data.int64[i];
            }
            order = 0;
            break;
        case FLAC__SUBFRAME_TYPE_FIXED: {
            const FLAC__Subframe_Fixed *fixed = &sub->data.fixed;
            order = fixed->order;
            if (order > FLAC__MAX_FIXED_ORDER || order > n) return 0;
            for (uint32_t i = 0; i < order; ++i) values[i] = fixed->warmup[i];
            for (uint32_t i = order; i < n; ++i) {
                __int128 p;
                switch (order) {
                    case 0: p = 0; break;
                    case 1: p = values[i - 1]; break;
                    case 2: p = 2 * (__int128)values[i - 1] - values[i - 2]; break;
                    case 3: p = 3 * (__int128)values[i - 1] - 3 * (__int128)values[i - 2] + values[i - 3]; break;
                    case 4: p = 4 * (__int128)values[i - 1] - 6 * (__int128)values[i - 2] +
                                      4 * (__int128)values[i - 3] - values[i - 4]; break;
                    default: return 0;
                }
                int64_t result;
                if (!checked_i64(p + fixed->residual[i - order], &result)) return 0;
                values[i] = result;
            }
            break;
        }
        case FLAC__SUBFRAME_TYPE_LPC: {
            const FLAC__Subframe_LPC *lpc = &sub->data.lpc;
            order = lpc->order;
            if (order == 0 || order > MAX_LPC || order > n ||
                lpc->qlp_coeff_precision < FLAC__MIN_QLP_COEFF_PRECISION ||
                lpc->qlp_coeff_precision > FLAC__MAX_QLP_COEFF_PRECISION ||
                lpc->quantization_level < -16 || lpc->quantization_level > 15)
                return 0;
            for (uint32_t i = 0; i < order; ++i) values[i] = lpc->warmup[i];
            for (uint32_t i = order; i < n; ++i) {
                __int128 sum = 0;
                for (uint32_t j = 0; j < order; ++j)
                    sum += (__int128)lpc->qlp_coeff[j] * values[i - 1 - j];
                __int128 shifted;
                if (!floor_pow2_shift(sum, lpc->quantization_level, &shifted)) return 0;
                int64_t result;
                if (!checked_i64(shifted + lpc->residual[i - order], &result)) return 0;
                values[i] = result;
            }
            break;
        }
        default:
            return 0;
    }

    if (wasted) {
        if (wasted >= 63) return 0;
        for (uint32_t i = 0; i < n; ++i) {
            int64_t shifted;
            if (!checked_i64((__int128)values[i] * (((__int128)1) << wasted), &shifted)) return 0;
            values[i] = shifted;
        }
    }

    uint32_t side = (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE && channel == 1) ||
                    (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE && channel == 0) ||
                    (frame->header.channel_assignment == FLAC__CHANNEL_ASSIGNMENT_MID_SIDE && channel == 1);
    uint32_t width = frame->header.bits_per_sample + side;
    if (width >= 63) return 0;
    int64_t minimum = -((int64_t)1 << (width - 1));
    int64_t maximum = ((int64_t)1 << (width - 1)) - 1;
    for (uint32_t i = 0; i < n; ++i)
        if (values[i] < minimum || values[i] > maximum) return 0;

    (void)decoded;
    return 1;
}

static int compare_frame(const FLAC__Frame *frame, const FLAC__int32 * const buffer[]) {
    uint32_t n = frame->header.blocksize;
    if (frame->header.channels != 2 || n > MAX_BLOCK) return 0;
    int64_t *channel[2] = {calloc(n, sizeof(int64_t)), calloc(n, sizeof(int64_t))};
    if (!channel[0] || !channel[1]) {
        free(channel[0]);
        free(channel[1]);
        return 0;
    }
    int ok = restore_subframe(frame, 0, buffer[0], channel[0]) &&
             restore_subframe(frame, 1, buffer[1], channel[1]);
    if (ok) {
        for (uint32_t i = 0; i < n && ok; ++i) {
            int64_t left, right;
            switch (frame->header.channel_assignment) {
                case FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT:
                    left = channel[0][i]; right = channel[1][i]; break;
                case FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE:
                    left = channel[0][i];
                    if (!checked_i64((__int128)channel[0][i] - channel[1][i], &right)) ok = 0;
                    break;
                case FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE:
                    right = channel[1][i];
                    if (!checked_i64((__int128)channel[1][i] + channel[0][i], &left)) ok = 0;
                    break;
                case FLAC__CHANNEL_ASSIGNMENT_MID_SIDE: {
                    int64_t twice;
                    if (!checked_i64(2 * (__int128)channel[0][i] + (channel[1][i] & 1), &twice) ||
                        !checked_i64((__int128)twice + channel[1][i], &left) ||
                        !checked_i64((__int128)twice - channel[1][i], &right)) { ok = 0; continue; }
                    left /= 2;
                    right /= 2;
                    break;
                }
                default: ok = 0; continue;
            }
            if (!ok) continue;
            if (left < -(1LL << 23) || left >= (1LL << 23) ||
                right < -(1LL << 23) || right >= (1LL << 23) ||
                left != buffer[0][i] || right != buffer[1][i]) ok = 0;
        }
    }
    free(channel[0]);
    free(channel[1]);
    return ok;
}

static int write_subframe(FILE *f, const FLAC__Frame *frame, unsigned channel) {
    const FLAC__Subframe *sub = &frame->subframes[channel];
    uint8_t type = (uint8_t)sub->type;
    uint8_t wasted = (uint8_t)sub->wasted_bits;
    uint32_t order = 0, precision = 0, count = 0, partitions = 0;
    int8_t shift = 0;
    uint8_t method = 255, partition_order = 0;
    const FLAC__int32 *data = NULL;
    const int64_t *warmup = NULL;
    const int32_t *coefficients = NULL;
    const FLAC__EntropyCodingMethod *entropy = NULL;
    switch (sub->type) {
        case FLAC__SUBFRAME_TYPE_CONSTANT:
            count = 1;
            break;
        case FLAC__SUBFRAME_TYPE_VERBATIM:
            count = frame->header.blocksize;
            break;
        case FLAC__SUBFRAME_TYPE_FIXED:
            order = sub->data.fixed.order;
            count = frame->header.blocksize - order;
            method = (uint8_t)sub->data.fixed.entropy_coding_method.type;
            partition_order = (uint8_t)sub->data.fixed.entropy_coding_method.data.partitioned_rice.order;
            partitions = 1u << partition_order;
            data = sub->data.fixed.residual;
            warmup = sub->data.fixed.warmup;
            entropy = &sub->data.fixed.entropy_coding_method;
            break;
        case FLAC__SUBFRAME_TYPE_LPC:
            order = sub->data.lpc.order;
            precision = sub->data.lpc.qlp_coeff_precision;
            shift = (int8_t)sub->data.lpc.quantization_level;
            count = frame->header.blocksize - order;
            method = (uint8_t)sub->data.lpc.entropy_coding_method.type;
            partition_order = (uint8_t)sub->data.lpc.entropy_coding_method.data.partitioned_rice.order;
            partitions = 1u << partition_order;
            data = sub->data.lpc.residual;
            warmup = sub->data.lpc.warmup;
            coefficients = sub->data.lpc.qlp_coeff;
            entropy = &sub->data.lpc.entropy_coding_method;
            break;
        default:
            return 0;
    }
    if ((sub->type == FLAC__SUBFRAME_TYPE_FIXED || sub->type == FLAC__SUBFRAME_TYPE_LPC) &&
        (partition_order > MAX_PARTITION || partition_order > 15 || !entropy || !data)) return 0;
    if (!put_u8(f, type) || !put_u8(f, wasted) || !put_u8(f, (uint8_t)order) ||
        !put_u8(f, (uint8_t)precision) || !put_u8(f, (uint8_t)shift) ||
        !put_u8(f, method) || !put_u8(f, partition_order) || !put_u8(f, 0) ||
        !put_u32(f, count) || !put_u32(f, partitions)) return 0;
    for (uint32_t i = 0; i < order; ++i)
        if (!put_i32(f, (int32_t)warmup[i])) return 0;
    for (uint32_t i = 0; i < order && sub->type == FLAC__SUBFRAME_TYPE_LPC; ++i)
        if (!put_i32(f, coefficients[i])) return 0;
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT)
        return put_i32(f, (int32_t)sub->data.constant.value);
    if (sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        for (uint32_t i = 0; i < count; ++i) {
            int64_t value = sub->data.verbatim.data_type == FLAC__VERBATIM_SUBFRAME_DATA_TYPE_INT32
                                ? sub->data.verbatim.data.int32[i]
                                : sub->data.verbatim.data.int64[i];
            if (value < INT32_MIN || value > INT32_MAX || !put_i32(f, (int32_t)value)) return 0;
        }
        return 1;
    }
    const FLAC__EntropyCodingMethod_PartitionedRice *rice =
        &entropy->data.partitioned_rice;
    for (uint32_t p = 0; p < partitions; ++p) {
        uint32_t parameter = rice->contents->parameters[p];
        uint32_t raw = rice->contents->raw_bits[p];
        uint32_t width = method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE ? 4u : 5u;
        uint32_t escape = method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                              ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                              : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
        if (parameter >= (1u << width) || (parameter == escape && raw > 31)) return 0;
        if (!put_u8(f, (uint8_t)parameter) || !put_u8(f, (uint8_t)raw) || !put_u16(f, 0)) return 0;
    }
    for (uint32_t i = 0; i < count; ++i)
        if (!put_i32(f, data[i])) return 0;
    return 1;
}

static FLAC__StreamDecoderWriteStatus extract_write(
    const FLAC__StreamDecoder *decoder, const FLAC__Frame *frame,
    const FLAC__int32 * const buffer[], void *client_data) {
    ExtractContext *ctx = client_data;
    FLAC__uint64 end = 0;
    if (ctx->error || frame->header.channels != 2 || frame->header.bits_per_sample != 24 ||
        frame->header.sample_rate != 44100 ||
        frame->header.blocksize == 0 || frame->header.blocksize > MAX_BLOCK ||
        !FLAC__stream_decoder_get_decode_position(decoder, &end) ||
        end < ctx->previous_end || !compare_frame(frame, buffer)) {
        fprintf(stderr, "round1: callback PCM/model validation failed\n");
        ctx->error = 1;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    uint64_t start = ctx->previous_end;
    uint64_t frame_bytes = end - start;
    if (frame_bytes == 0 || frame_bytes > UINT32_MAX) {
        ctx->error = 1;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    uint64_t audio_before = stats_audio_bits(&ctx->stats);
    if (!stats_frame(&ctx->stats, frame)) {
        fprintf(stderr, "round1: stats validation failed at frame %" PRIu64 "\n", start);
        ctx->error = 1;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    uint64_t audio_bits = stats_audio_bits(&ctx->stats) - audio_before;
    uint32_t header_bytes;
    if (!ctx->headers || !parse_frame_header(ctx->headers, start, frame->header.blocksize,
                                             (uint8_t)frame->header.channel_assignment, &header_bytes)) {
        fprintf(stderr, "round1: frame header parse failed at frame %" PRIu64 "\n", start);
        ctx->error = 1;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    uint64_t frame_bits = (uint64_t)header_bytes * 8u + audio_bits + 16u;
    uint64_t padding = (8u - (audio_bits & 7u)) & 7u;
    frame_bits += padding;
    if (frame_bits != frame_bytes * 8u) {
        fprintf(stderr, "round1: frame bit reconciliation failed at %" PRIu64
                        " (%" PRIu64 " != %" PRIu64 ", h=%u audio=%" PRIu64 " pad=%" PRIu64 ")\n",
                        start, frame_bits, frame_bytes * 8u, header_bytes, audio_bits, padding);
        fprintf(stderr, "  bits sh=%" PRIu64 " w=%" PRIu64 " warm=%" PRIu64
                        " coeff=%" PRIu64 " const=%" PRIu64 " verb=%" PRIu64
                        " rh=%" PRIu64 " q=%" PRIu64 " rem=%" PRIu64 " raw=%" PRIu64 "\n",
                ctx->stats.subframe_header_bits, ctx->stats.wasted_bits,
                ctx->stats.warmup_bits, ctx->stats.coefficient_bits, ctx->stats.constant_bits,
                ctx->stats.verbatim_bits, ctx->stats.residual_header_bits,
                ctx->stats.quotient_bits, ctx->stats.remainder_bits, ctx->stats.escaped_raw_bits);
        for (unsigned ci = 0; ci < frame->header.channels; ++ci) {
            const FLAC__Subframe *ss = &frame->subframes[ci];
            fprintf(stderr, "  sub%u type=%d wasted=%u ", ci, ss->type, ss->wasted_bits);
            if (ss->type == FLAC__SUBFRAME_TYPE_FIXED)
                fprintf(stderr, "order=%u method=%d part=%u\n", ss->data.fixed.order,
                        ss->data.fixed.entropy_coding_method.type,
                        ss->data.fixed.entropy_coding_method.data.partitioned_rice.order);
            else if (ss->type == FLAC__SUBFRAME_TYPE_LPC)
                fprintf(stderr, "order=%u method=%d part=%u\n", ss->data.lpc.order,
                        ss->data.lpc.entropy_coding_method.type,
                        ss->data.lpc.entropy_coding_method.data.partitioned_rice.order);
            else fputc('\n', stderr);
        }
        ctx->error = 1;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    ctx->stats.frame_header_bits += (uint64_t)header_bytes * 8u;
    ctx->stats.frame_crc_bits += 16u;
    ctx->stats.frame_padding_bits += padding;
    ctx->stats.frame_bytes += frame_bytes;
    ctx->stats.frame_count++;
    off_t record_start = ftello(ctx->records);
    if (record_start < 0 || !put_u32(ctx->records, 0) ||
        !put_u32(ctx->records, ctx->chunk_index) ||
        !put_u64(ctx->records, ctx->packed_base + frame->header.number.sample_number) ||
        !put_u64(ctx->records, start) || !put_u32(ctx->records, (uint32_t)frame_bytes) ||
        !put_u32(ctx->records, frame->header.blocksize) ||
        !put_u8(ctx->records, (uint8_t)frame->header.channel_assignment) ||
        !put_u8(ctx->records, (uint8_t)frame->header.channels) ||
        !put_u8(ctx->records, (uint8_t)frame->header.bits_per_sample) ||
        !put_u8(ctx->records, 0) || !write_subframe(ctx->records, frame, 0) ||
        !write_subframe(ctx->records, frame, 1)) {
        ctx->error = 1;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    off_t record_end = ftello(ctx->records);
    if (record_end < record_start || (uint64_t)(record_end - record_start - 4) > UINT32_MAX) {
        ctx->error = 1;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    uint32_t record_bytes = (uint32_t)(record_end - record_start - 4);
    if (record_bytes > MAX_RECORD || fseeko(ctx->records, record_start, SEEK_SET) != 0 ||
        !put_u32(ctx->records, record_bytes) || fseeko(ctx->records, record_end, SEEK_SET) != 0) {
        ctx->error = 1;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    ctx->previous_end = end;
    ctx->last_position = end;
    ctx->record_count++;
    ctx->frame_count++;
    ctx->pcm_samples += frame->header.blocksize;
    ctx->copied_bytes += (uint64_t)frame->header.blocksize * frame->header.channels * 3u;
    return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
}

static void extract_metadata(const FLAC__StreamDecoder *decoder,
                             const FLAC__StreamMetadata *metadata, void *client_data) {
    ExtractContext *ctx = client_data;
    FLAC__uint64 position = 0;
    if (!FLAC__stream_decoder_get_decode_position(decoder, &position)) {
        ctx->error = 1;
        return;
    }
    ctx->metadata_end = position;
    ctx->previous_end = position;
    ctx->last_position = position;
    ctx->saw_metadata = 1;
    if (metadata->type == FLAC__METADATA_TYPE_STREAMINFO) {
        ctx->saw_streaminfo = 1;
        if (metadata->data.stream_info.sample_rate != 44100 ||
            metadata->data.stream_info.channels != 2 ||
            metadata->data.stream_info.bits_per_sample != 24)
            ctx->error = 1;
    }
}

static void extract_error(const FLAC__StreamDecoder *decoder,
                          FLAC__StreamDecoderErrorStatus status, void *client_data) {
    (void)decoder;
    ExtractContext *ctx = client_data;
    ctx->error = 1;
    fprintf(stderr, "round1: decoder error %s\n", FLAC__StreamDecoderErrorStatusString[status]);
}

static int copy_file(FILE *src, FILE *dst, uint64_t length) {
    uint8_t buffer[65536];
    while (length) {
        size_t want = length < sizeof buffer ? (size_t)length : sizeof buffer;
        if (fread(buffer, 1, want, src) != want || fwrite(buffer, 1, want, dst) != want) return 0;
        length -= want;
    }
    return 1;
}

static int file_size(FILE *f, uint64_t *size) {
    off_t current = ftello(f);
    if (current < 0 || fseeko(f, 0, SEEK_END) != 0) return 0;
    off_t end = ftello(f);
    if (end < 0 || fseeko(f, current, SEEK_SET) != 0) return 0;
    *size = (uint64_t)end;
    return 1;
}

static int write_record_header(FILE *records, const char *manifest_path, uint64_t *manifest_length_offset) {
    FILE *manifest = fopen(manifest_path, "rb");
    uint64_t length;
    if (!manifest || !file_size(manifest, &length) || length > UINT32_MAX) {
        if (manifest) fclose(manifest);
        return 0;
    }
    if (!write_bytes(records, MAGIC, 8) || !put_u64(records, length)) {
        fclose(manifest);
        return 0;
    }
    *manifest_length_offset = (uint64_t)ftello(records);
    if (!put_u64(records, 0) || fseeko(manifest, 0, SEEK_SET) != 0 ||
        !copy_file(manifest, records, length)) {
        fclose(manifest);
        return 0;
    }
    fclose(manifest);
    return 1;
}

static int patch_u64(FILE *f, uint64_t offset, uint64_t value) {
    if (fseeko(f, (off_t)offset, SEEK_SET) != 0 || !put_u64(f, value)) return 0;
    return fseeko(f, 0, SEEK_END) == 0;
}

static int write_u64_values(FILE *f, const uint64_t *values, size_t count) {
    for (size_t i = 0; i < count; ++i) if (!put_u64(f, values[i])) return 0;
    return 1;
}

static int write_double_values(FILE *f, const double *values, size_t count) {
    if (sizeof(double) != 8) return 0;
    return fwrite(values, sizeof(double), count, f) == count;
}

static int write_stats(const char *path, const Stats *stats) {
    FILE *f = fopen(path, "wb");
    if (!f || !write_bytes(f, "I77ST01", 7) || !put_u8(f, 1)) goto fail;
    if (!write_u64_values(f, stats->type_counts, 4) ||
        !write_u64_values(f, stats->order_counts, 33) ||
        !write_u64_values(f, stats->assignment_counts, 4) ||
        !write_u64_values(f, stats->method_counts, 2) ||
        !write_u64_values(f, stats->k_counts, 32)) goto fail;
    const uint64_t scalar[] = {
        stats->residual_samples, stats->ordinary_samples, stats->escaped_partitions,
        stats->escaped_samples, stats->subframes, stats->ordinary_subframes,
        stats->subframe_header_bits, stats->wasted_bits, stats->warmup_bits,
        stats->coefficient_bits, stats->constant_bits, stats->verbatim_bits,
        stats->residual_header_bits, stats->quotient_bits, stats->remainder_bits,
        stats->escaped_raw_bits, stats->frame_header_bits, stats->frame_crc_bits,
        stats->frame_padding_bits, stats->frame_bytes, stats->frame_count};
    if (!write_u64_values(f, scalar, sizeof scalar / sizeof scalar[0]) ||
        !write_double_values(f, &stats->residual_sum, 1) ||
        !write_double_values(f, &stats->residual_sum_sq, 1) ||
        !write_u64_values(f, stats->lag_counts, LAG_COUNT) ||
        !write_double_values(f, stats->lag_corr_sum, LAG_COUNT) ||
        !write_u64_values(f, &stats->qhist[0][0][0], 4u * 32u * 17u) ||
        !write_u64_values(f, &stats->conthist[0][0][0][0], 4u * 32u * 5u * 17u) ||
        !write_u64_values(f, &stats->remhist[0][0][0][0], 4u * 32u * 31u * 2u)) goto fail;
    if (fclose(f) != 0) return 0;
    return 1;
fail:
    if (f) fclose(f);
    remove(path);
    return 0;
}

static int do_extract(const char *input_path, const char *manifest_path,
                      const char *records_path, const char *summary_path, const char *stats_path,
                      uint32_t chunk_index, uint64_t packed_base) {
    FILE *records = NULL;
    FILE *headers = NULL;
    FLAC__StreamDecoder *decoder = NULL;
    uint64_t count_offset = 0;
    struct stat input_stat;
    if (stat(input_path, &input_stat) != 0 || input_stat.st_size <= 0) {
        failf("cannot stat FLAC input");
        return 2;
    }
    records = fopen(records_path, "wb+");
    if (!records || !write_record_header(records, manifest_path, &count_offset)) {
        failf("cannot create diagnostic record");
        if (records) fclose(records);
        return 2;
    }
    headers = fopen(input_path, "rb");
    if (!headers) { failf("cannot open FLAC header view"); fclose(records); remove(records_path); return 2; }
    ExtractContext context = {.records = records, .headers = headers,
                              .chunk_index = chunk_index, .packed_base = packed_base};
    decoder = FLAC__stream_decoder_new();
    if (!decoder) { failf("libFLAC decoder allocation failed"); goto fail; }
    FLAC__stream_decoder_set_md5_checking(decoder, 1);
    FLAC__stream_decoder_set_metadata_respond_all(decoder);
    FLAC__StreamDecoderInitStatus status = FLAC__stream_decoder_init_file(
        decoder, input_path, extract_write, extract_metadata, extract_error, &context);
    if (status != FLAC__STREAM_DECODER_INIT_STATUS_OK ||
        !FLAC__stream_decoder_process_until_end_of_stream(decoder) ||
        !FLAC__stream_decoder_finish(decoder) || context.error ||
        !context.saw_metadata || !context.saw_streaminfo || context.record_count == 0 ||
        context.previous_end != (uint64_t)input_stat.st_size) {
        fprintf(stderr, "round1: extraction failed for %s (%s)\n", input_path,
                FLAC__StreamDecoderStateString[FLAC__stream_decoder_get_state(decoder)]);
        goto fail;
    }
    FLAC__stream_decoder_delete(decoder);
    decoder = NULL;
    if (!patch_u64(records, count_offset, context.record_count) || fflush(records) != 0) goto fail;
    fclose(records);
    fclose(headers);
    headers = NULL;
    if (!write_stats(stats_path, &context.stats)) goto fail_no_headers;
    FILE *summary = fopen(summary_path, "wb");
    if (!summary) { failf("cannot write extraction summary"); return 2; }
    fprintf(summary,
            "{\"format\":\"issue77-round1-extract-v1\",\"chunkIndex\":%u,"
            "\"packedStartFrame\":%" PRIu64 ",\"recordCount\":%" PRIu64 ","
            "\"frameCount\":%" PRIu64 ",\"metadataBytes\":%" PRIu64 ","
            "\"frameBytes\":%" PRIu64 ",\"pcmBytes\":%" PRIu64 "}\n",
            chunk_index, packed_base, context.record_count, context.frame_count, context.metadata_end,
            context.previous_end - context.metadata_end, context.copied_bytes);
    fclose(summary);
    return 0;
fail:
    if (decoder) FLAC__stream_decoder_delete(decoder);
    if (headers) fclose(headers);
    fclose(records);
    remove(records_path);
    remove(stats_path);
    return 2;
fail_no_headers:
    remove(records_path);
    remove(stats_path);
    return 2;
}

static int write_s24(FILE *f, int64_t value) {
    if (value < -(1LL << 23) || value >= (1LL << 23)) return 0;
    uint32_t x = (uint32_t)(int32_t)value;
    uint8_t b[3] = {(uint8_t)x, (uint8_t)(x >> 8), (uint8_t)(x >> 16)};
    return write_bytes(f, b, sizeof b);
}

static int read_record_subframe(FILE *f, uint32_t blocksize, uint8_t assignment,
                                unsigned channel, uint8_t bps, int64_t *values) {
    uint8_t type, wasted, order8, precision8, shift8, method, partition_order, reserved;
    uint32_t count, partition_count;
    if (!get_u8(f, &type) || !get_u8(f, &wasted) || !get_u8(f, &order8) ||
        !get_u8(f, &precision8) || !get_u8(f, &shift8) || !get_u8(f, &method) ||
        !get_u8(f, &partition_order) || !get_u8(f, &reserved) || !get_u32(f, &count) ||
        !get_u32(f, &partition_count) || reserved != 0 || type > 3 ||
        blocksize == 0 || blocksize > MAX_BLOCK) return 0;
    uint32_t side = (assignment == FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE && channel == 1) ||
                    (assignment == FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE && channel == 0) ||
                    (assignment == FLAC__CHANNEL_ASSIGNMENT_MID_SIDE && channel == 1);
    uint32_t channel_bps = (uint32_t)bps + side;
    if (wasted >= channel_bps || order8 > blocksize || order8 > MAX_LPC ||
        (type == FLAC__SUBFRAME_TYPE_LPC && ((int8_t)shift8 < -16 || (int8_t)shift8 > 15))) return 0;
    uint32_t order = order8;
    int shift = (int8_t)shift8;
    if (type == FLAC__SUBFRAME_TYPE_CONSTANT || type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        if (order || precision8 || shift || method != 255 || partition_order || partition_count) return 0;
        uint32_t expected = type == FLAC__SUBFRAME_TYPE_CONSTANT ? 1u : blocksize;
        if (count != expected) return 0;
    } else {
        if ((type == FLAC__SUBFRAME_TYPE_FIXED && order > FLAC__MAX_FIXED_ORDER) ||
            (type == FLAC__SUBFRAME_TYPE_LPC && order == 0)) return 0;
        if (method > FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2 ||
            partition_order > MAX_PARTITION || partition_count != (1u << partition_order) ||
            count != blocksize - order || (type == FLAC__SUBFRAME_TYPE_FIXED && (precision8 || shift)) ||
            (type == FLAC__SUBFRAME_TYPE_LPC && (precision8 < FLAC__MIN_QLP_COEFF_PRECISION ||
                                                  precision8 > FLAC__MAX_QLP_COEFF_PRECISION))) return 0;
    }
    int64_t warmup[MAX_LPC] = {0};
    int32_t coefficients[MAX_LPC] = {0};
    for (uint32_t i = 0; i < order; ++i) {
        int32_t value;
        if (!get_i32(f, &value)) return 0;
        warmup[i] = value;
    }
    if (type == FLAC__SUBFRAME_TYPE_LPC)
        for (uint32_t i = 0; i < order; ++i) {
            if (!get_i32(f, &coefficients[i])) return 0;
            int64_t minimum = -((int64_t)1 << (precision8 - 1));
            int64_t maximum = ((int64_t)1 << (precision8 - 1)) - 1;
            if (coefficients[i] < minimum || coefficients[i] > maximum) return 0;
        }
    if (type == FLAC__SUBFRAME_TYPE_CONSTANT) {
        int32_t value;
        if (!get_i32(f, &value)) return 0;
        for (uint32_t i = 0; i < blocksize; ++i) values[i] = value;
    } else if (type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        for (uint32_t i = 0; i < blocksize; ++i) {
            int32_t value;
            if (!get_i32(f, &value)) return 0;
            values[i] = value;
        }
    } else {
        uint8_t *parameters = calloc(partition_count, sizeof(uint8_t));
        uint8_t *raw_widths = calloc(partition_count, sizeof(uint8_t));
        if (!parameters || !raw_widths) { free(parameters); free(raw_widths); return 0; }
        unsigned width = method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE ? 4u : 5u;
        unsigned escape = method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                              ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                              : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
        uint32_t partitions = 1u << partition_order;
        if (partitions == 0 || blocksize % partitions != 0 ||
            blocksize / partitions < order) {
            free(parameters); free(raw_widths); return 0;
        }
        for (uint32_t p = 0; p < partition_count; ++p) {
            uint16_t reserved16;
            if (!get_u8(f, &parameters[p]) || !get_u8(f, &raw_widths[p]) ||
                !get_u16(f, &reserved16) || reserved16 || parameters[p] >= (1u << width) ||
                (parameters[p] == escape && raw_widths[p] > 31) ||
                (parameters[p] != escape && raw_widths[p] != 0)) {
                free(parameters); free(raw_widths); return 0;
            }
        }
        uint32_t index = 0;
        for (uint32_t p = 0; p < partition_count; ++p) {
            uint32_t partition_size = blocksize / partitions;
            uint32_t partition_values = partition_size - (p == 0 ? order : 0);
            if (index + partition_values > count) {
                free(parameters); free(raw_widths); return 0;
            }
            for (uint32_t j = 0; j < partition_values; ++j) {
                int32_t value;
                if (!get_i32(f, &value)) { free(parameters); free(raw_widths); return 0; }
                if (parameters[p] == escape) {
                    uint64_t u = value >= 0 ? (uint64_t)value * 2u :
                                 (uint64_t)(-2 * (int64_t)value - 1);
                    if (u >= (UINT64_C(1) << raw_widths[p])) {
                        free(parameters); free(raw_widths); return 0;
                    }
                }
                values[order + index++] = value;
            }
        }
        if (index != count) { free(parameters); free(raw_widths); return 0; }
        free(parameters);
        free(raw_widths);
        for (uint32_t i = 0; i < order; ++i) values[i] = warmup[i];
        for (uint32_t i = order; i < blocksize; ++i) {
            uint32_t residual_index = i - order;
            __int128 prediction;
            if (type == FLAC__SUBFRAME_TYPE_FIXED) {
                switch (order) {
                    case 0: prediction = 0; break;
                    case 1: prediction = values[i - 1]; break;
                    case 2: prediction = 2 * (__int128)values[i - 1] - values[i - 2]; break;
                    case 3: prediction = 3 * (__int128)values[i - 1] - 3 * (__int128)values[i - 2] + values[i - 3]; break;
                    case 4: prediction = 4 * (__int128)values[i - 1] - 6 * (__int128)values[i - 2] +
                                             4 * (__int128)values[i - 3] - values[i - 4]; break;
                    default: return 0;
                }
            } else {
                prediction = 0;
                for (uint32_t j = 0; j < order; ++j) prediction += (__int128)coefficients[j] * values[i - 1 - j];
                if (!floor_pow2_shift(prediction, shift, &prediction)) return 0;
            }
            int64_t result;
            /* Residuals were read into values[order..]; use the saved value
             * before overwriting that slot. */
            int32_t residual;
            if (residual_index >= blocksize - order) return 0;
            residual = (int32_t)values[order + residual_index];
            if (!checked_i64(prediction + residual, &result)) return 0;
            values[i] = result;
        }
    }
    if (wasted) {
        if (wasted >= 63) return 0;
        for (uint32_t i = 0; i < blocksize; ++i)
            if (!checked_i64((__int128)values[i] * (((__int128)1) << wasted), &values[i])) return 0;
    }
    if (channel_bps >= 63) return 0;
    int64_t minimum = -((int64_t)1 << (channel_bps - 1));
    int64_t maximum = ((int64_t)1 << (channel_bps - 1)) - 1;
    for (uint32_t i = 0; i < blocksize; ++i)
        if (values[i] < minimum || values[i] > maximum) return 0;
    return 1;
}

static int decode_one_record(FILE *f, FILE *out, uint32_t record_bytes,
                             DecodeContext *ctx) {
    off_t start = ftello(f);
    uint32_t chunk;
    uint64_t packed, offset;
    uint32_t frame_bytes, blocksize;
    uint8_t assignment, channels, bps, reserved;
    if (start < 0 || record_bytes > MAX_RECORD || record_bytes < 32 ||
        !get_u32(f, &chunk) || !get_u64(f, &packed) || !get_u64(f, &offset) ||
        !get_u32(f, &frame_bytes) || !get_u32(f, &blocksize) || !get_u8(f, &assignment) ||
        !get_u8(f, &channels) || !get_u8(f, &bps) || !get_u8(f, &reserved) || reserved ||
        channels != 2 || bps != 24 || assignment > FLAC__CHANNEL_ASSIGNMENT_MID_SIDE ||
        blocksize == 0 || blocksize > MAX_BLOCK || frame_bytes == 0) return 0;
    if (ctx->has_previous &&
        (packed != ctx->previous_packed + ctx->previous_blocksize ||
         (chunk == ctx->previous_chunk ? offset <= ctx->previous_offset : chunk != ctx->previous_chunk + 1))) return 0;
    int64_t *values[2] = {calloc(blocksize, sizeof(int64_t)), calloc(blocksize, sizeof(int64_t))};
    if (!values[0] || !values[1]) { free(values[0]); free(values[1]); return 0; }
    if (!read_record_subframe(f, blocksize, assignment, 0, bps, values[0]) ||
        !read_record_subframe(f, blocksize, assignment, 1, bps, values[1])) {
        free(values[0]); free(values[1]); return 0;
    }
    off_t end = ftello(f);
    if (end < start || (uint64_t)(end - start) != record_bytes) {
        free(values[0]); free(values[1]); return 0;
    }
    for (uint32_t i = 0; i < blocksize; ++i) {
        int64_t left, right;
        switch (assignment) {
            case FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT:
                left = values[0][i]; right = values[1][i]; break;
            case FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE:
                left = values[0][i];
                if (!checked_i64((__int128)values[0][i] - values[1][i], &right)) {
                    free(values[0]); free(values[1]); return 0;
                }
                break;
            case FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE:
                right = values[1][i];
                if (!checked_i64((__int128)values[1][i] + values[0][i], &left)) {
                    free(values[0]); free(values[1]); return 0;
                }
                break;
            case FLAC__CHANNEL_ASSIGNMENT_MID_SIDE: {
                int64_t twice;
                if (!checked_i64(2 * (__int128)values[0][i] + (values[1][i] & 1), &twice) ||
                    !checked_i64((__int128)twice + values[1][i], &left) ||
                    !checked_i64((__int128)twice - values[1][i], &right)) {
                    free(values[0]); free(values[1]); return 0;
                }
                left /= 2;
                right /= 2;
                break;
            }
            default: free(values[0]); free(values[1]); return 0;
        }
        if (!write_s24(out, left) || !write_s24(out, right)) {
            free(values[0]); free(values[1]); return 0;
        }
    }
    free(values[0]);
    free(values[1]);
    ctx->record_count++;
    ctx->frame_count++;
    ctx->pcm_samples += blocksize;
    ctx->previous_packed = packed;
    ctx->previous_offset = offset;
    ctx->previous_blocksize = blocksize;
    ctx->previous_chunk = chunk;
    ctx->has_previous = 1;
    (void)chunk;
    (void)frame_bytes;
    return 1;
}

static int do_decode(const char *records_path, const char *output_path,
                     const char *summary_path) {
    FILE *records = fopen(records_path, "rb");
    FILE *out = NULL;
    if (!records) { failf("cannot open diagnostic record"); return 2; }
    char magic[8];
    uint64_t manifest_length, expected_records;
    if (!read_bytes(records, magic, sizeof magic) || memcmp(magic, MAGIC, 8) != 0 ||
        !get_u64(records, &manifest_length) || !get_u64(records, &expected_records) ||
        manifest_length > 64u * 1024u * 1024u) {
        failf("invalid diagnostic record header"); fclose(records); return 2;
    }
    if (fseeko(records, (off_t)manifest_length, SEEK_CUR) != 0) {
        failf("truncated diagnostic manifest"); fclose(records); return 2;
    }
    out = fopen(output_path, "wb");
    if (!out) { failf("cannot create reconstructed PCM"); fclose(records); return 2; }
    DecodeContext context = {.out = out};
    for (uint64_t i = 0; i < expected_records; ++i) {
        uint32_t record_bytes;
        if (!get_u32(records, &record_bytes) || !decode_one_record(records, out, record_bytes, &context)) {
            failf("invalid or inconsistent diagnostic record");
            fclose(out); fclose(records); remove(output_path); return 2;
        }
    }
    uint8_t trailing;
    if (fread(&trailing, 1, 1, records) != 0 || ferror(records) || context.record_count != expected_records) {
        failf("diagnostic record has trailing bytes or wrong count");
        fclose(out); fclose(records); remove(output_path); return 2;
    }
    if (fflush(out) != 0) { fclose(out); fclose(records); remove(output_path); return 2; }
    fclose(out);
    fclose(records);
    FILE *summary = fopen(summary_path, "wb");
    if (!summary) { remove(output_path); return 2; }
    fprintf(summary, "{\"format\":\"issue77-round1-decode-v1\",\"recordCount\":%" PRIu64
                    ",\"frameCount\":%" PRIu64 ",\"pcmBytes\":%" PRIu64 "}\n",
            context.record_count, context.frame_count, context.pcm_samples * 6u);
    fclose(summary);
    return 0;
}

static void usage(const char *program) {
    fprintf(stderr,
            "usage:\n  %s extract INPUT MANIFEST RECORDS SUMMARY STATS CHUNK_INDEX PACKED_START\n"
            "  %s decode RECORDS OUTPUT SUMMARY\n", program, program);
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "extract") == 0 && argc == 9)
        return do_extract(argv[2], argv[3], argv[4], argv[5], argv[6],
                          (uint32_t)strtoul(argv[7], NULL, 10), strtoull(argv[8], NULL, 10));
    if (argc >= 2 && strcmp(argv[1], "decode") == 0 && argc == 5)
        return do_decode(argv[2], argv[3], argv[4]);
    usage(argv[0]);
    return 2;
}
