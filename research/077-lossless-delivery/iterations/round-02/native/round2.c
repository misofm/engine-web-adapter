/*
 * Issue #77 round 2: matched Rice and context byte-rANS records.
 *
 * The round-1 native helper is included read-only for its checked predictor,
 * stereo, and little-endian primitives.  This file has its own format parser,
 * bit readers/writers, and entropy coder; no production code is involved.
 */
#define main round1_legacy_main
#include "../../round-01/native/round1.c"
#undef main

#include <inttypes.h>

#define R2_MAGIC "I77ENT02"
#define R2_RSD_MAGIC "I77RSD01"
#define R2_PROFILE 1u
#define R2_SCALE_BITS 12u
#define R2_SCALE (1u << R2_SCALE_BITS)
#define R2_L (1u << 23)
#define R2_MAX_MANIFEST (1024u * 1024u)
#define R2_MAX_FRAME_BODY (4u * 1024u * 1024u)
#define R2_MAX_TABLES (4u * 31u * 5u)
#define R2_MAX_SUBFRAME_BYTES (4u * 1024u * 1024u)

typedef struct {
    uint8_t type;
    uint8_t wasted;
    uint8_t order;
    uint8_t precision;
    int8_t shift;
    uint8_t method;
    uint8_t partition_order;
    uint32_t count;
    uint32_t partition_count;
    int32_t warmup[MAX_LPC];
    int32_t coefficients[MAX_LPC];
    uint8_t parameters[1u << MAX_PARTITION];
    uint8_t raw_widths[1u << MAX_PARTITION];
    int32_t *data;
} R2_Subframe;

typedef struct {
    uint32_t chunk;
    uint64_t packed;
    uint64_t source_offset;
    uint32_t source_bytes;
    uint16_t blocksize;
    uint8_t assignment;
    R2_Subframe sub[2];
} R2_Frame;

typedef struct {
    FILE *file;
    uint8_t *manifest;
    uint64_t manifest_length;
    uint64_t record_count;
    off_t records_start;
} R2_Rsd;

typedef struct {
    uint8_t *data;
    size_t length;
    size_t capacity;
    unsigned bit_count;
} R2_Bits;

typedef struct {
    uint8_t *data;
    size_t length;
    size_t capacity;
} R2_Bytes;

typedef struct {
    uint8_t role;
    uint8_t k;
    uint8_t context;
    uint16_t freq[17];
    uint16_t cumulative[18];
    uint8_t symbol[4096];
} R2_Table;

typedef struct {
    uint64_t counts[4][31][5][17];
    R2_Table tables[R2_MAX_TABLES];
    uint32_t table_count;
    int16_t index[4][31][5];
} R2_Model;

typedef struct {
    FILE *file;
    uint64_t bytes;
} R2_Audit;

typedef struct {
    uint8_t *data;
    size_t length;
    size_t position;
} R2_Cursor;

static void r2_fail(const char *message) {
    fprintf(stderr, "round2: %s\n", message);
}

static int r2_bytes_reserve(R2_Bytes *bytes, size_t extra) {
    if (extra > SIZE_MAX - bytes->length) return 0;
    size_t required = bytes->length + extra;
    if (required > R2_MAX_FRAME_BODY) return 0;
    if (required <= bytes->capacity) return 1;
    size_t capacity = bytes->capacity ? bytes->capacity : 4096;
    while (capacity < required) {
        if (capacity > SIZE_MAX / 2) return 0;
        capacity *= 2;
    }
    uint8_t *data = realloc(bytes->data, capacity);
    if (!data) return 0;
    bytes->data = data;
    bytes->capacity = capacity;
    return 1;
}

static int r2_bytes_push(R2_Bytes *bytes, uint8_t value) {
    if (!r2_bytes_reserve(bytes, 1)) return 0;
    bytes->data[bytes->length++] = value;
    return 1;
}

static int r2_bytes_write(R2_Bytes *bytes, const uint8_t *data, size_t length) {
    if (!r2_bytes_reserve(bytes, length)) return 0;
    if (length != 0) memcpy(bytes->data + bytes->length, data, length);
    bytes->length += length;
    return 1;
}

static void r2_bytes_free(R2_Bytes *bytes) {
    free(bytes->data);
    memset(bytes, 0, sizeof *bytes);
}

static int r2_bits_reserve(R2_Bits *bits, size_t extra_bytes) {
    if (extra_bytes > SIZE_MAX - bits->length) return 0;
    size_t required = bits->length + extra_bytes;
    if (required > R2_MAX_FRAME_BODY) return 0;
    if (required <= bits->capacity) return 1;
    size_t capacity = bits->capacity ? bits->capacity : 4096;
    while (capacity < required) {
        if (capacity > SIZE_MAX / 2) return 0;
        capacity *= 2;
    }
    uint8_t *data = realloc(bits->data, capacity);
    if (!data) return 0;
    bits->data = data;
    bits->capacity = capacity;
    return 1;
}

static int r2_bits_put(R2_Bits *bits, uint32_t value, unsigned width) {
    if (width > 32) return 0;
    for (unsigned i = width; i > 0; --i) {
        if ((bits->bit_count & 7u) == 0 && !r2_bits_reserve(bits, 1)) return 0;
        if ((bits->bit_count & 7u) == 0) bits->data[bits->length++] = 0;
        uint8_t bit = (uint8_t)((value >> (i - 1)) & 1u);
        bits->data[bits->length - 1] |= (uint8_t)(bit << (7u - (bits->bit_count & 7u)));
        bits->bit_count++;
    }
    return 1;
}

static int r2_bits_zeros(R2_Bits *bits, size_t count) {
    while (count--) if (!r2_bits_put(bits, 0, 1)) return 0;
    return 1;
}

static int r2_bits_align(R2_Bits *bits) {
    unsigned pad = (8u - (bits->bit_count & 7u)) & 7u;
    return r2_bits_zeros(bits, pad);
}

static void r2_bits_free(R2_Bits *bits) {
    free(bits->data);
    memset(bits, 0, sizeof *bits);
}

static int r2_bits_read(const uint8_t *data, size_t length, size_t *position,
                        uint32_t *value, unsigned width) {
    if (width > 32 || *position > length * 8u || width > length * 8u - *position) return 0;
    uint32_t result = 0;
    for (unsigned i = 0; i < width; ++i) {
        size_t bit = *position + i;
        result = (result << 1) | ((data[bit >> 3] >> (7u - (bit & 7u))) & 1u);
    }
    *position += width;
    *value = result;
    return 1;
}

static int r2_bits_signed(R2_Bits *bits, int32_t value, unsigned width) {
    if (width == 0 || width > 32) return 0;
    uint32_t mask = width == 32 ? UINT32_MAX : ((UINT32_C(1) << width) - 1u);
    return r2_bits_put(bits, (uint32_t)value & mask, width);
}

static int r2_read_signed(const uint8_t *data, size_t length, size_t *position,
                          int32_t *value, unsigned width) {
    uint32_t raw;
    if (width == 0 || width > 32 || !r2_bits_read(data, length, position, &raw, width)) return 0;
    if (width == 32) {
        *value = (int32_t)raw;
    } else if (raw & (UINT32_C(1) << (width - 1))) {
        *value = (int32_t)(raw | (UINT32_MAX << width));
    } else {
        *value = (int32_t)raw;
    }
    return 1;
}

static int r2_cursor_take(R2_Cursor *cursor, void *out, size_t length) {
    if (length > cursor->length - cursor->position) return 0;
    memcpy(out, cursor->data + cursor->position, length);
    cursor->position += length;
    return 1;
}

static int r2_cursor_u8(R2_Cursor *cursor, uint8_t *value) {
    return r2_cursor_take(cursor, value, 1);
}

static int r2_cursor_u16(R2_Cursor *cursor, uint16_t *value) {
    uint8_t b[2];
    if (!r2_cursor_take(cursor, b, 2)) return 0;
    *value = (uint16_t)b[0] | ((uint16_t)b[1] << 8);
    return 1;
}

static int r2_cursor_u32(R2_Cursor *cursor, uint32_t *value) {
    uint8_t b[4];
    if (!r2_cursor_take(cursor, b, 4)) return 0;
    *value = (uint32_t)b[0] | ((uint32_t)b[1] << 8) |
             ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
    return 1;
}

static int r2_cursor_u64(R2_Cursor *cursor, uint64_t *value) {
    uint8_t b[8];
    if (!r2_cursor_take(cursor, b, 8)) return 0;
    *value = 0;
    for (unsigned i = 0; i < 8; ++i) *value |= (uint64_t)b[i] << (8u * i);
    return 1;
}

static int r2_cursor_i32(R2_Cursor *cursor, int32_t *value) {
    uint32_t raw;
    if (!r2_cursor_u32(cursor, &raw)) return 0;
    *value = (int32_t)raw;
    return 1;
}

static int r2_file_u32(FILE *file, uint32_t *value) {
    return get_u32(file, value);
}

static int r2_file_u64(FILE *file, uint64_t *value) {
    return get_u64(file, value);
}

static void r2_free_frame(R2_Frame *frame) {
    for (unsigned channel = 0; channel < 2; ++channel) {
        free(frame->sub[channel].data);
        frame->sub[channel].data = NULL;
    }
}

static int r2_read_subframe(R2_Cursor *cursor, uint32_t blocksize,
                            uint8_t assignment, unsigned channel, R2_Subframe *sub) {
    uint8_t reserved;
    if (!r2_cursor_u8(cursor, &sub->type) || !r2_cursor_u8(cursor, &sub->wasted) ||
        !r2_cursor_u8(cursor, &sub->order) || !r2_cursor_u8(cursor, &sub->precision)) return 0;
    uint8_t shift;
    if (!r2_cursor_u8(cursor, &shift) || !r2_cursor_u8(cursor, &sub->method) ||
        !r2_cursor_u8(cursor, &sub->partition_order) || !r2_cursor_u8(cursor, &reserved) ||
        !r2_cursor_u32(cursor, &sub->count) || !r2_cursor_u32(cursor, &sub->partition_count) ||
        reserved != 0 || sub->type > 3 || blocksize == 0 || blocksize > MAX_BLOCK) return 0;
    sub->shift = (int8_t)shift;
    unsigned side = (assignment == FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE && channel == 1) ||
                    (assignment == FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE && channel == 0) ||
                    (assignment == FLAC__CHANNEL_ASSIGNMENT_MID_SIDE && channel == 1);
    unsigned channel_bps = 24u + side;
    if (sub->wasted >= channel_bps || sub->order > blocksize || sub->order > MAX_LPC) return 0;
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT || sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        if (sub->order || sub->precision || sub->shift || sub->method != 255 ||
            sub->partition_order || sub->partition_count ||
            sub->count != (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT ? 1u : blocksize)) return 0;
    } else {
        if ((sub->type == FLAC__SUBFRAME_TYPE_FIXED && sub->order > FLAC__MAX_FIXED_ORDER) ||
            (sub->type == FLAC__SUBFRAME_TYPE_LPC && (sub->order == 0 ||
             sub->precision < FLAC__MIN_QLP_COEFF_PRECISION ||
             sub->precision > FLAC__MAX_QLP_COEFF_PRECISION || sub->shift < -16 || sub->shift > 15)) ||
            sub->method > FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2 ||
            sub->partition_order > MAX_PARTITION || sub->partition_count != (1u << sub->partition_order) ||
            sub->count != blocksize - sub->order) return 0;
        uint32_t partitions = 1u << sub->partition_order;
        if (blocksize % partitions != 0 || blocksize / partitions < sub->order) return 0;
    }
    for (uint32_t i = 0; i < sub->order; ++i)
        if (!r2_cursor_i32(cursor, &sub->warmup[i])) return 0;
    if (sub->type == FLAC__SUBFRAME_TYPE_LPC) {
        int64_t minimum = -((int64_t)1 << (sub->precision - 1));
        int64_t maximum = ((int64_t)1 << (sub->precision - 1)) - 1;
        for (uint32_t i = 0; i < sub->order; ++i) {
            if (!r2_cursor_i32(cursor, &sub->coefficients[i]) ||
                sub->coefficients[i] < minimum || sub->coefficients[i] > maximum) return 0;
        }
    }
    sub->data = calloc(sub->count ? sub->count : 1, sizeof(*sub->data));
    if (!sub->data) return 0;
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT || sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        for (uint32_t i = 0; i < sub->count; ++i)
            if (!r2_cursor_i32(cursor, &sub->data[i])) return 0;
        return 1;
    }
    unsigned width = sub->method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE ? 4u : 5u;
    unsigned escape = sub->method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                          ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                          : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
    for (uint32_t p = 0; p < sub->partition_count; ++p) {
        uint16_t reserved16;
        if (!r2_cursor_u8(cursor, &sub->parameters[p]) || !r2_cursor_u8(cursor, &sub->raw_widths[p]) ||
            !r2_cursor_u16(cursor, &reserved16) || reserved16 || sub->parameters[p] >= (1u << width) ||
            (sub->parameters[p] == escape && sub->raw_widths[p] > 31) ||
            (sub->parameters[p] != escape && sub->raw_widths[p] != 0)) return 0;
    }
    uint32_t index = 0;
    uint32_t partition_size = blocksize / (1u << sub->partition_order);
    for (uint32_t p = 0; p < sub->partition_count; ++p) {
        uint32_t count = partition_size - (p == 0 ? sub->order : 0);
        if (index + count > sub->count) return 0;
        for (uint32_t i = 0; i < count; ++i) {
            if (!r2_cursor_i32(cursor, &sub->data[index])) return 0;
            if (sub->parameters[p] == escape) {
                uint64_t u = sub->data[index] >= 0 ? (uint64_t)sub->data[index] * 2u :
                             (uint64_t)(-2 * (int64_t)sub->data[index] - 1);
                if (u >= (UINT64_C(1) << sub->raw_widths[p])) return 0;
            }
            index++;
        }
    }
    return index == sub->count;
}

static int r2_parse_frame(const uint8_t *body, size_t length, R2_Frame *frame) {
    R2_Cursor cursor = {.data = (uint8_t *)body, .length = length};
    uint8_t channels, bps, reserved;
    uint32_t blocksize;
    if (!r2_cursor_u32(&cursor, &frame->chunk) || !r2_cursor_u64(&cursor, &frame->packed) ||
        !r2_cursor_u64(&cursor, &frame->source_offset) || !r2_cursor_u32(&cursor, &frame->source_bytes) ||
        !r2_cursor_u32(&cursor, &blocksize) || !r2_cursor_u8(&cursor, &frame->assignment) ||
        !r2_cursor_u8(&cursor, &channels) || !r2_cursor_u8(&cursor, &bps) ||
        !r2_cursor_u8(&cursor, &reserved) || reserved || channels != 2 || bps != 24 ||
        frame->assignment > FLAC__CHANNEL_ASSIGNMENT_MID_SIDE || blocksize == 0 || blocksize > MAX_BLOCK ||
        frame->source_bytes == 0 || blocksize > UINT16_MAX) return 0;
    frame->blocksize = (uint16_t)blocksize;
    if (!r2_read_subframe(&cursor, blocksize, frame->assignment, 0, &frame->sub[0]) ||
        !r2_read_subframe(&cursor, blocksize, frame->assignment, 1, &frame->sub[1]) ||
        cursor.position != cursor.length) {
        r2_free_frame(frame);
        return 0;
    }
    return 1;
}

static int r2_read_rsd_header(FILE *file, R2_Rsd *input) {
    char magic[8];
    if (!read_bytes(file, magic, sizeof magic) || memcmp(magic, R2_RSD_MAGIC, 8) != 0 ||
        !r2_file_u64(file, &input->manifest_length) || !r2_file_u64(file, &input->record_count) ||
        input->manifest_length > R2_MAX_MANIFEST) return 0;
    input->manifest = malloc(input->manifest_length ? (size_t)input->manifest_length : 1);
    if (!input->manifest || !read_bytes(file, input->manifest, (size_t)input->manifest_length)) return 0;
    off_t position = ftello(file);
    if (position < 0) return 0;
    input->records_start = position;
    return 1;
}

static int r2_read_rsd_frame(FILE *file, R2_Frame *frame) {
    uint32_t body_bytes;
    if (!r2_file_u32(file, &body_bytes) || body_bytes == 0 || body_bytes > MAX_RECORD) return 0;
    uint8_t *body = malloc(body_bytes);
    if (!body || !read_bytes(file, body, body_bytes)) { free(body); return 0; }
    memset(frame, 0, sizeof *frame);
    int ok = r2_parse_frame(body, body_bytes, frame);
    free(body);
    return ok;
}

static int r2_rewind_rsd(R2_Rsd *input) {
    return fseeko(input->file, input->records_start, SEEK_SET) == 0;
}

static void r2_close_rsd(R2_Rsd *input) {
    if (input->file) fclose(input->file);
    free(input->manifest);
    memset(input, 0, sizeof *input);
}

static int r2_open_rsd(const char *path, R2_Rsd *input) {
    memset(input, 0, sizeof *input);
    input->file = fopen(path, "rb");
    if (!input->file || !r2_read_rsd_header(input->file, input)) {
        r2_close_rsd(input);
        return 0;
    }
    return 1;
}

static int r2_fold(int32_t residual, uint32_t *u) {
    int64_t wide = residual;
    uint64_t folded = wide >= 0 ? (uint64_t)wide * 2u : (uint64_t)(-2 * wide - 1);
    if (folded > UINT32_MAX) return 0;
    *u = (uint32_t)folded;
    return 1;
}

static int r2_role(uint8_t assignment, unsigned channel, uint8_t *role) {
    switch (assignment) {
        case FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT: *role = (uint8_t)channel; return 1;
        case FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE: *role = channel == 0 ? 0u : 3u; return 1;
        case FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE: *role = channel == 0 ? 3u : 1u; return 1;
        case FLAC__CHANNEL_ASSIGNMENT_MID_SIDE: *role = channel == 0 ? 2u : 3u; return 1;
        default: return 0;
    }
}

static int r2_subframe_hist(R2_Model *model, const R2_Subframe *sub,
                            uint8_t assignment, unsigned channel) {
    if (sub->type != FLAC__SUBFRAME_TYPE_FIXED && sub->type != FLAC__SUBFRAME_TYPE_LPC) return 1;
    uint8_t role;
    if (!r2_role(assignment, channel, &role)) return 0;
    unsigned escape = sub->method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                          ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                          : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
    uint32_t index = 0;
    uint32_t partition_size = sub->count + sub->order;
    partition_size >>= sub->partition_order;
    for (uint32_t p = 0; p < sub->partition_count; ++p) {
        uint32_t count = partition_size - (p == 0 ? sub->order : 0);
        uint32_t previous_class = 4;
        unsigned k = sub->parameters[p];
        for (uint32_t i = 0; i < count; ++i) {
            uint32_t u;
            if (!r2_fold(sub->data[index++], &u)) return 0;
            if (k != escape) {
                uint32_t q = u >> k;
                uint32_t symbol = q >= 16 ? 16u : q;
                model->counts[role][k][previous_class][symbol]++;
                previous_class = q > 3 ? 3u : q;
            }
        }
    }
    return index == sub->count;
}

static int r2_table_key_compare(uint8_t role_a, uint8_t k_a, uint8_t context_a,
                                uint8_t role_b, uint8_t k_b, uint8_t context_b) {
    if (role_a != role_b) return role_a < role_b ? -1 : 1;
    if (k_a != k_b) return k_a < k_b ? -1 : 1;
    if (context_a != context_b) return context_a < context_b ? -1 : 1;
    return 0;
}

static int r2_normalize_model(R2_Model *model) {
    for (unsigned role = 0; role < 4; ++role)
        for (unsigned k = 0; k < 31; ++k)
            for (unsigned context = 0; context < 5; ++context)
                model->index[role][k][context] = -1;
    for (unsigned role = 0; role < 4; ++role) {
        for (unsigned k = 0; k < 31; ++k) {
            for (unsigned context = 0; context < 5; ++context) {
                uint64_t total = 0;
                unsigned observed = 0;
                for (unsigned symbol = 0; symbol < 17; ++symbol) {
                    total += model->counts[role][k][context][symbol];
                    if (model->counts[role][k][context][symbol]) observed++;
                }
                if (!total) continue;
                if (model->table_count >= R2_MAX_TABLES || observed > R2_SCALE - 1) return 0;
                uint32_t table_index = model->table_count++;
                R2_Table *table = &model->tables[table_index];
                table->role = (uint8_t)role;
                table->k = (uint8_t)k;
                table->context = (uint8_t)context;
                model->index[role][k][context] = (int16_t)table_index;
                uint64_t used = observed;
                uint64_t remainder = R2_SCALE - observed;
                uint64_t rem_num[17] = {0};
                for (unsigned symbol = 0; symbol < 17; ++symbol) {
                    uint64_t count = model->counts[role][k][context][symbol];
                    if (!count) {
                        table->freq[symbol] = 0;
                        continue;
                    }
                    uint64_t numerator = remainder * count;
                    table->freq[symbol] = (uint16_t)(1u + numerator / total);
                    rem_num[symbol] = numerator % total;
                    used += numerator / total;
                }
                uint64_t left = R2_SCALE - used;
                for (unsigned pass = 0; pass < left; ++pass) {
                    unsigned best = 17;
                    for (unsigned symbol = 0; symbol < 17; ++symbol) {
                        if (!model->counts[role][k][context][symbol]) continue;
                        if (best == 17 || rem_num[symbol] > rem_num[best] ||
                            (rem_num[symbol] == rem_num[best] && symbol < best)) best = symbol;
                    }
                    if (best == 17 || table->freq[best] == UINT16_MAX) return 0;
                    table->freq[best]++;
                    rem_num[best] = 0;
                }
                uint32_t cumulative = 0;
                for (unsigned symbol = 0; symbol < 17; ++symbol) {
                    table->cumulative[symbol] = (uint16_t)cumulative;
                    for (uint32_t slot = 0; slot < table->freq[symbol]; ++slot) {
                        if (cumulative + slot >= R2_SCALE) return 0;
                        table->symbol[cumulative + slot] = (uint8_t)symbol;
                    }
                    cumulative += table->freq[symbol];
                }
                table->cumulative[17] = (uint16_t)cumulative;
                if (cumulative != R2_SCALE) return 0;
            }
        }
    }
    return 1;
}

static R2_Table *r2_find_table(R2_Model *model, uint8_t role, uint8_t k, uint8_t context) {
    if (role >= 4 || k >= 31 || context >= 5) return NULL;
    int16_t index = model->index[role][k][context];
    return index < 0 || (uint32_t)index >= model->table_count ? NULL : &model->tables[index];
}

static int r2_audit_u8(R2_Audit *audit, uint8_t value) {
    if (!put_u8(audit->file, value)) return 0;
    audit->bytes++;
    return 1;
}

static int r2_audit_u16(R2_Audit *audit, uint16_t value) {
    if (!put_u16(audit->file, value)) return 0;
    audit->bytes += 2;
    return 1;
}

static int r2_audit_u32(R2_Audit *audit, uint32_t value) {
    if (!put_u32(audit->file, value)) return 0;
    audit->bytes += 4;
    return 1;
}

static int r2_audit_i32(R2_Audit *audit, int32_t value) {
    return r2_audit_u32(audit, (uint32_t)value);
}

static int r2_audit_frame(R2_Audit *audit, const R2_Frame *frame) {
    if (!audit || !audit->file) return 1;
    if (!r2_audit_u16(audit, frame->blocksize) || !r2_audit_u8(audit, frame->assignment) ||
        !r2_audit_u8(audit, 0)) return 0;
    for (unsigned channel = 0; channel < 2; ++channel) {
        const R2_Subframe *sub = &frame->sub[channel];
        if (!r2_audit_u8(audit, sub->type) || !r2_audit_u8(audit, sub->wasted) ||
            !r2_audit_u8(audit, sub->order) || !r2_audit_u8(audit, sub->precision) ||
            !r2_audit_u8(audit, (uint8_t)sub->shift) || !r2_audit_u8(audit, sub->method) ||
            !r2_audit_u8(audit, sub->partition_order) || !r2_audit_u8(audit, 0) ||
            !r2_audit_u32(audit, sub->count)) return 0;
        for (uint32_t i = 0; i < sub->order; ++i) if (!r2_audit_i32(audit, sub->warmup[i])) return 0;
        if (sub->type == FLAC__SUBFRAME_TYPE_LPC)
            for (uint32_t i = 0; i < sub->order; ++i)
                if (!r2_audit_i32(audit, sub->coefficients[i])) return 0;
        if (sub->type == FLAC__SUBFRAME_TYPE_FIXED || sub->type == FLAC__SUBFRAME_TYPE_LPC) {
            for (uint32_t p = 0; p < sub->partition_count; ++p)
                if (!r2_audit_u8(audit, sub->parameters[p]) ||
                    !r2_audit_u8(audit, sub->raw_widths[p])) return 0;
        }
        for (uint32_t i = 0; i < sub->count; ++i) if (!r2_audit_i32(audit, sub->data[i])) return 0;
    }
    return 1;
}

static int r2_side_header(R2_Bits *bits, const R2_Subframe *sub,
                          uint8_t assignment, unsigned channel) {
    unsigned side = (assignment == FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE && channel == 1) ||
                    (assignment == FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE && channel == 0) ||
                    (assignment == FLAC__CHANNEL_ASSIGNMENT_MID_SIDE && channel == 1);
    unsigned bps = 24u + side;
    unsigned type_code = sub->type == FLAC__SUBFRAME_TYPE_CONSTANT ? 0u :
                         sub->type == FLAC__SUBFRAME_TYPE_VERBATIM ? 1u :
                         sub->type == FLAC__SUBFRAME_TYPE_FIXED ? 8u + sub->order :
                         32u + sub->order - 1u;
    if (!r2_bits_put(bits, 0, 1) || !r2_bits_put(bits, type_code, 6) ||
        !r2_bits_put(bits, sub->wasted ? 1u : 0u, 1)) return 0;
    if (sub->wasted) {
        if (!r2_bits_zeros(bits, sub->wasted - 1u) || !r2_bits_put(bits, 1, 1)) return 0;
    }
    unsigned width = bps - sub->wasted;
    if (sub->type == FLAC__SUBFRAME_TYPE_FIXED || sub->type == FLAC__SUBFRAME_TYPE_LPC)
        for (uint32_t i = 0; i < sub->order; ++i)
            if (!r2_bits_signed(bits, sub->warmup[i], width)) return 0;
    if (sub->type == FLAC__SUBFRAME_TYPE_LPC) {
        if (!r2_bits_put(bits, sub->precision - 1u, 4) || !r2_bits_put(bits, (uint8_t)sub->shift, 5)) return 0;
        for (uint32_t i = 0; i < sub->order; ++i)
            if (!r2_bits_signed(bits, sub->coefficients[i], sub->precision)) return 0;
    }
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT || sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        for (uint32_t i = 0; i < sub->count; ++i)
            if (!r2_bits_signed(bits, sub->data[i], width)) return 0;
    } else {
        unsigned method_width = sub->method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE ? 1u : 2u;
        if (!r2_bits_put(bits, method_width == 1 ? 0u : 1u, 2) ||
            !r2_bits_put(bits, sub->partition_order, 4)) return 0;
        unsigned escape = sub->method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                              ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                              : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
        unsigned parameter_width = method_width == 1 ? 4u : 5u;
        for (uint32_t p = 0; p < sub->partition_count; ++p) {
            if (!r2_bits_put(bits, sub->parameters[p], parameter_width)) return 0;
            if (sub->parameters[p] == escape && !r2_bits_put(bits, sub->raw_widths[p], 5)) return 0;
        }
    }
    return r2_bits_align(bits);
}

static int r2_raw_bits(R2_Bits *bits, int32_t value, unsigned width) {
    if (width == 0) return value == 0;
    uint32_t mask = width == 32 ? UINT32_MAX : ((UINT32_C(1) << width) - 1u);
    return r2_bits_put(bits, (uint32_t)value & mask, width);
}

static int r2_partition_bounds(const R2_Subframe *sub, uint32_t partition,
                               uint32_t *start, uint32_t *count) {
    uint32_t blocksize = sub->count + sub->order;
    uint32_t partition_size = blocksize / (1u << sub->partition_order);
    *start = 0;
    for (uint32_t p = 0; p < partition; ++p)
        *start += partition_size - (p == 0 ? sub->order : 0);
    *count = partition_size - (partition == 0 ? sub->order : 0);
    return *start <= sub->count && *count <= sub->count - *start;
}

static int r2_encode_rice(const R2_Subframe *sub, R2_Bits *entropy,
                          R2_Bits *bypass, uint8_t assignment, unsigned channel) {
    (void)assignment;
    (void)channel;
    unsigned escape = sub->method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                          ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                          : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
    uint32_t index = 0;
    for (uint32_t p = 0; p < sub->partition_count; ++p) {
        uint32_t start, count;
        if (!r2_partition_bounds(sub, p, &start, &count) || start != index) return 0;
        unsigned k = sub->parameters[p];
        for (uint32_t i = 0; i < count; ++i, ++index) {
            uint32_t u;
            if (!r2_fold(sub->data[index], &u)) return 0;
            if (k == escape) {
                if (!r2_raw_bits(entropy, sub->data[index], sub->raw_widths[p])) return 0;
            } else {
                uint32_t q = u >> k;
                uint64_t needed = (uint64_t)q + 1u + k;
                if (needed > (uint64_t)R2_MAX_FRAME_BODY * 8u - entropy->bit_count) return 0;
                if (q > 0 && !r2_bits_zeros(entropy, q)) return 0;
                if (!r2_bits_put(entropy, 1, 1) || !r2_bits_put(entropy, u, k)) return 0;
            }
        }
    }
    return index == sub->count && bypass->length == 0;
}

static int r2_encode_rans(const R2_Subframe *sub, R2_Model *model,
                          R2_Bytes *entropy, R2_Bits *bypass,
                          uint8_t assignment, unsigned channel) {
    uint8_t role;
    if (!r2_role(assignment, channel, &role)) return 0;
    unsigned escape = sub->method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                          ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                          : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
    uint8_t *symbols = malloc(sub->count ? sub->count : 1);
    uint8_t *contexts = malloc(sub->count ? sub->count : 1);
    uint8_t *keys = malloc(sub->count ? sub->count : 1);
    if (!symbols || !contexts || !keys) { free(symbols); free(contexts); free(keys); return 0; }
    uint32_t symbol_count = 0, index = 0;
    for (uint32_t p = 0; p < sub->partition_count; ++p) {
        uint32_t start, count;
        if (!r2_partition_bounds(sub, p, &start, &count) || start != index) {
            free(symbols); free(contexts); free(keys); return 0;
        }
        unsigned k = sub->parameters[p];
        uint32_t previous_class = 4;
        for (uint32_t i = 0; i < count; ++i, ++index) {
            uint32_t u;
            if (!r2_fold(sub->data[index], &u)) {
                free(symbols); free(contexts); free(keys); return 0;
            }
            if (k == escape) {
                if (!r2_raw_bits(bypass, sub->data[index], sub->raw_widths[p])) {
                    free(symbols); free(contexts); free(keys); return 0;
                }
                continue;
            }
            uint32_t q = u >> k;
            uint8_t symbol = (uint8_t)(q >= 16 ? 16u : q);
            R2_Table *table = r2_find_table(model, role, (uint8_t)k, (uint8_t)previous_class);
            if (!table) {
                free(symbols); free(contexts); free(keys); return 0;
            }
            symbols[symbol_count] = symbol;
            contexts[symbol_count] = (uint8_t)previous_class;
            keys[symbol_count] = (uint8_t)k;
            symbol_count++;
            if (symbol == 16) {
                if (!r2_bits_put(bypass, q, 32)) {
                    free(symbols); free(contexts); free(keys); return 0;
                }
            }
            if (!r2_bits_put(bypass, u, k)) {
                free(symbols); free(contexts); free(keys); return 0;
            }
            previous_class = q > 3 ? 3u : q;
        }
    }
    if (index != sub->count) {
        free(symbols); free(contexts); free(keys); return 0;
    }
    if (symbol_count == 0) {
        free(symbols); free(contexts); free(keys); return 1;
    }
    uint32_t state = R2_L;
    R2_Bytes emitted = {0};
    for (uint32_t reverse = symbol_count; reverse > 0; --reverse) {
        uint8_t symbol = symbols[reverse - 1];
        uint8_t context = contexts[reverse - 1];
        uint8_t k = keys[reverse - 1];
        R2_Table *table = r2_find_table(model, role, k, context);
        if (!table || !table->freq[symbol]) {
            free(symbols); free(contexts); free(keys); r2_bytes_free(&emitted); return 0;
        }
        uint32_t f = table->freq[symbol];
        uint32_t c = table->cumulative[symbol];
        uint64_t threshold = ((uint64_t)(R2_L >> R2_SCALE_BITS) << 8) * f;
        while ((uint64_t)state >= threshold) {
            if (!r2_bytes_push(&emitted, (uint8_t)state)) {
                free(symbols); free(contexts); free(keys); r2_bytes_free(&emitted); return 0;
            }
            state >>= 8;
        }
        state = (state / f) * R2_SCALE + (state % f) + c;
        if (state < R2_L || (uint64_t)state >= (uint64_t)R2_L * 256u) {
            free(symbols); free(contexts); free(keys); r2_bytes_free(&emitted); return 0;
        }
    }
    if (!r2_bytes_reserve(entropy, 4 + emitted.length)) {
        free(symbols); free(contexts); free(keys); r2_bytes_free(&emitted); return 0;
    }
    entropy->data[entropy->length++] = (uint8_t)state;
    entropy->data[entropy->length++] = (uint8_t)(state >> 8);
    entropy->data[entropy->length++] = (uint8_t)(state >> 16);
    entropy->data[entropy->length++] = (uint8_t)(state >> 24);
    for (size_t i = emitted.length; i > 0; --i)
        entropy->data[entropy->length++] = emitted.data[i - 1];
    free(symbols);
    free(contexts);
    free(keys);
    r2_bytes_free(&emitted);
    return 1;
}

typedef struct {
    uint64_t frame_count;
    uint64_t predictive_subframes;
    uint64_t side_bytes;
    uint64_t entropy_bytes;
    uint64_t bypass_bytes;
    uint64_t frame_bytes;
    uint64_t record_count;
    uint64_t audit_bytes;
} R2_Metrics;

static int r2_append_u32(R2_Bytes *bytes, uint32_t value) {
    uint8_t b[4] = {(uint8_t)value, (uint8_t)(value >> 8),
                    (uint8_t)(value >> 16), (uint8_t)(value >> 24)};
    return r2_bytes_write(bytes, b, sizeof b);
}

static int r2_encode_subframe(const R2_Subframe *sub, R2_Model *model, uint8_t mode,
                              uint8_t assignment, unsigned channel, R2_Bytes *output,
                              R2_Metrics *metrics) {
    R2_Bits side = {0};
    R2_Bits entropy_bits = {0};
    R2_Bits bypass_bits = {0};
    R2_Bytes entropy_bytes = {0};
    if (!r2_side_header(&side, sub, assignment, channel)) goto fail;
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT || sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        if (!r2_bytes_write(output, side.data, side.length)) goto fail;
        metrics->side_bytes += side.length;
        r2_bits_free(&side);
        return 1;
    }
    metrics->predictive_subframes++;
    if (mode == 0) {
        if (!r2_encode_rice(sub, &entropy_bits, &bypass_bits, assignment, channel) ||
            !r2_bits_align(&entropy_bits)) goto fail;
        if (!r2_bytes_write(&entropy_bytes, entropy_bits.data, entropy_bits.length)) goto fail;
    } else {
        if (!r2_encode_rans(sub, model, &entropy_bytes, &bypass_bits, assignment, channel) ||
            !r2_bits_align(&bypass_bits)) goto fail;
    }
    if (side.length > UINT32_MAX || entropy_bytes.length > UINT32_MAX ||
        (bypass_bits.length > UINT32_MAX)) goto fail;
    if (!r2_bytes_write(output, side.data, side.length) ||
        !r2_append_u32(output, (uint32_t)entropy_bytes.length) ||
        !r2_append_u32(output, (uint32_t)bypass_bits.length) ||
        !r2_bytes_write(output, entropy_bytes.data, entropy_bytes.length) ||
        !r2_bytes_write(output, bypass_bits.data, bypass_bits.length)) goto fail;
    metrics->side_bytes += side.length;
    metrics->entropy_bytes += entropy_bytes.length;
    metrics->bypass_bytes += bypass_bits.length;
    r2_bits_free(&side);
    r2_bits_free(&entropy_bits);
    r2_bits_free(&bypass_bits);
    r2_bytes_free(&entropy_bytes);
    return 1;
fail:
    r2_bits_free(&side);
    r2_bits_free(&entropy_bits);
    r2_bits_free(&bypass_bits);
    r2_bytes_free(&entropy_bytes);
    return 0;
}

static int r2_encode_frame(const R2_Frame *frame, R2_Model *model, uint8_t mode,
                           FILE *output, R2_Metrics *metrics) {
    R2_Bytes body = {0};
    uint8_t prefix[4] = {(uint8_t)frame->blocksize, (uint8_t)(frame->blocksize >> 8),
                         frame->assignment, 0};
    if (!r2_bytes_write(&body, prefix, sizeof prefix) ||
        !r2_encode_subframe(&frame->sub[0], model, mode, frame->assignment, 0, &body, metrics) ||
        !r2_encode_subframe(&frame->sub[1], model, mode, frame->assignment, 1, &body, metrics) ||
        body.length > R2_MAX_FRAME_BODY || body.length > UINT32_MAX) {
        r2_bytes_free(&body);
        return 0;
    }
    uint8_t length[4] = {(uint8_t)body.length, (uint8_t)(body.length >> 8),
                         (uint8_t)(body.length >> 16), (uint8_t)(body.length >> 24)};
    int ok = write_bytes(output, length, sizeof length) && write_bytes(output, body.data, body.length);
    if (ok) {
        metrics->frame_count++;
        metrics->frame_bytes += body.length + 4;
    }
    r2_bytes_free(&body);
    return ok;
}

static int r2_validate_sequence(const R2_Frame *frame, uint64_t index,
                                uint64_t *packed, uint32_t *previous_chunk,
                                uint64_t *previous_offset, int *has_previous) {
    if (!*has_previous) {
        if (frame->chunk != 0 || frame->packed != 0) return 0;
        *has_previous = 1;
    } else {
        if (frame->packed != *packed ||
            (frame->chunk == *previous_chunk ? frame->source_offset <= *previous_offset :
             frame->chunk != *previous_chunk + 1u)) return 0;
    }
    if (index == 0 && (frame->chunk != 0 || frame->packed != 0)) return 0;
    *packed += frame->blocksize;
    *previous_chunk = frame->chunk;
    *previous_offset = frame->source_offset;
    return 1;
}

static int r2_write_header(FILE *output, uint8_t mode, const R2_Rsd *input,
                           const R2_Model *model) {
    if (!write_bytes(output, R2_MAGIC, 8) || !put_u8(output, mode) || !put_u8(output, R2_PROFILE) ||
        !put_u16(output, 0) || !put_u64(output, input->manifest_length) ||
        !put_u64(output, input->record_count) || !put_u32(output, mode ? model->table_count : 0) ||
        !write_bytes(output, input->manifest, (size_t)input->manifest_length)) return 0;
    if (mode) {
        for (uint32_t i = 0; i < model->table_count; ++i) {
            const R2_Table *table = &model->tables[i];
            if (!put_u8(output, table->role) || !put_u8(output, table->k) ||
                !put_u8(output, table->context)) return 0;
            for (unsigned symbol = 0; symbol < 17; ++symbol)
                if (!put_u16(output, table->freq[symbol])) return 0;
        }
    }
    return 1;
}

static int r2_build_model(R2_Rsd *input, R2_Model *model) {
    memset(model, 0, sizeof *model);
    if (!r2_rewind_rsd(input)) return 0;
    uint64_t packed = 0, offset = 0;
    uint32_t chunk = 0;
    int has_previous = 0;
    for (uint64_t index = 0; index < input->record_count; ++index) {
        R2_Frame frame = {0};
        if (!r2_read_rsd_frame(input->file, &frame) ||
            !r2_validate_sequence(&frame, index, &packed, &chunk, &offset, &has_previous) ||
            !r2_subframe_hist(model, &frame.sub[0], frame.assignment, 0) ||
            !r2_subframe_hist(model, &frame.sub[1], frame.assignment, 1)) {
            r2_free_frame(&frame); return 0;
        }
        r2_free_frame(&frame);
    }
    int ch = fgetc(input->file);
    if (ch != EOF || ferror(input->file) || !r2_normalize_model(model)) return 0;
    return r2_rewind_rsd(input);
}

typedef struct {
    const uint8_t *entropy;
    size_t entropy_length;
    const uint8_t *bypass;
    size_t bypass_length;
} R2_Payload;

static int r2_padding_zero(const uint8_t *data, size_t length, size_t bit_position) {
    size_t total = length * 8u;
    if (bit_position > total || total - bit_position > 7u) return 0;
    while (bit_position < total) {
        if ((data[bit_position >> 3] & (uint8_t)(1u << (7u - (bit_position & 7u)))) != 0) return 0;
        bit_position++;
    }
    return 1;
}

static int r2_unfold(uint32_t u, int32_t *value) {
    if (u & 1u) {
        uint64_t magnitude = ((uint64_t)u + 1u) / 2u;
        if (magnitude > (uint64_t)INT32_MAX + 1u) return 0;
        *value = magnitude == (uint64_t)INT32_MAX + 1u ? INT32_MIN : -(int32_t)magnitude;
    } else {
        uint32_t magnitude = u / 2u;
        if (magnitude > INT32_MAX) return 0;
        *value = (int32_t)magnitude;
    }
    return 1;
}

static int r2_decode_rice_subframe(R2_Subframe *sub, const R2_Payload *payload) {
    size_t entropy_position = 0;
    uint32_t index = 0;
    unsigned escape = sub->method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                          ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                          : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
    for (uint32_t p = 0; p < sub->partition_count; ++p) {
        uint32_t start, count;
        if (!r2_partition_bounds(sub, p, &start, &count) || start != index) return 0;
        unsigned k = sub->parameters[p];
        for (uint32_t i = 0; i < count; ++i, ++index) {
            if (k == escape) {
                if (sub->raw_widths[p] == 0) sub->data[index] = 0;
                else if (!r2_read_signed(payload->entropy, payload->entropy_length, &entropy_position,
                                         &sub->data[index], sub->raw_widths[p])) return 0;
                uint32_t u;
                if (!r2_fold(sub->data[index], &u) || u >= (UINT32_C(1) << sub->raw_widths[p])) return 0;
                continue;
            }
            uint32_t q = 0, bit;
            do {
                if (q == UINT32_MAX || !r2_bits_read(payload->entropy, payload->entropy_length,
                                                      &entropy_position, &bit, 1)) return 0;
                if (bit == 0) q++;
            } while (bit == 0);
            uint32_t remainder;
            if (!r2_bits_read(payload->entropy, payload->entropy_length, &entropy_position, &remainder, k) ||
                (k && q > (UINT32_MAX >> k))) return 0;
            uint32_t u = (q << k) | remainder;
            if (!r2_unfold(u, &sub->data[index])) return 0;
        }
    }
    if (index != sub->count || payload->bypass_length != 0 ||
        !r2_padding_zero(payload->entropy, payload->entropy_length, entropy_position)) return 0;
    return 1;
}

static int r2_rans_symbol(R2_Table *table, uint32_t *state, const uint8_t *data,
                          size_t length, size_t *position, uint8_t *symbol) {
    if (*state < R2_L) return 0;
    uint32_t slot = *state & (R2_SCALE - 1u);
    *symbol = table->symbol[slot];
    uint32_t frequency = table->freq[*symbol];
    uint32_t cumulative = table->cumulative[*symbol];
    if (!frequency || slot < cumulative || slot >= cumulative + frequency) return 0;
    *state = frequency * (*state >> R2_SCALE_BITS) + slot - cumulative;
    while (*state < R2_L) {
        if (*position >= length) return 0;
        *state = (*state << 8) | data[(*position)++];
    }
    return 1;
}

static int r2_decode_rans_subframe(R2_Subframe *sub, const R2_Payload *payload,
                                   R2_Model *model, uint8_t assignment, unsigned channel) {
    uint8_t role;
    if (!r2_role(assignment, channel, &role)) return 0;
    unsigned escape = sub->method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                          ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                          : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
    uint32_t ordinary_count = 0;
    for (uint32_t p = 0; p < sub->partition_count; ++p) {
        uint32_t start, count;
        if (!r2_partition_bounds(sub, p, &start, &count)) return 0;
        unsigned pescape = sub->method == FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE
                               ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                               : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
        if (sub->parameters[p] != pescape) ordinary_count += count;
    }
    int has_ordinary = ordinary_count != 0;
    uint32_t state = 0;
    size_t entropy_position = 0, bypass_position = 0;
    if (has_ordinary) {
        if (payload->entropy_length < 4) return 0;
        state = (uint32_t)payload->entropy[0] | ((uint32_t)payload->entropy[1] << 8) |
                ((uint32_t)payload->entropy[2] << 16) | ((uint32_t)payload->entropy[3] << 24);
        if (state < R2_L || (uint64_t)state >= (uint64_t)R2_L * 256u) return 0;
        entropy_position = 4;
    } else if (payload->entropy_length != 0) {
        return 0;
    }
    uint32_t index = 0;
    for (uint32_t p = 0; p < sub->partition_count; ++p) {
        uint32_t start, count;
        if (!r2_partition_bounds(sub, p, &start, &count) || start != index) return 0;
        unsigned k = sub->parameters[p];
        uint32_t previous_class = 4;
        for (uint32_t i = 0; i < count; ++i, ++index) {
            uint32_t u;
            if (k == escape) {
                if (sub->raw_widths[p] == 0) sub->data[index] = 0;
                else if (!r2_read_signed(payload->bypass, payload->bypass_length, &bypass_position,
                                         &sub->data[index], sub->raw_widths[p])) return 0;
                if (!r2_fold(sub->data[index], &u) || u >= (UINT32_C(1) << sub->raw_widths[p])) return 0;
                continue;
            }
            R2_Table *table = r2_find_table(model, role, (uint8_t)k, (uint8_t)previous_class);
            uint8_t symbol;
            if (!table || !r2_rans_symbol(table, &state, payload->entropy,
                                         payload->entropy_length, &entropy_position, &symbol)) return 0;
            uint32_t q;
            if (symbol == 16) {
                if (!r2_bits_read(payload->bypass, payload->bypass_length, &bypass_position, &q, 32) || q < 16) return 0;
            } else q = symbol;
            uint32_t remainder;
            if ((k && q > (UINT32_MAX >> k)) ||
                !r2_bits_read(payload->bypass, payload->bypass_length, &bypass_position, &remainder, k)) return 0;
            u = (q << k) | remainder;
            if (!r2_unfold(u, &sub->data[index])) return 0;
            previous_class = q > 3 ? 3u : q;
        }
    }
    if (index != sub->count ||
        (has_ordinary && (state != R2_L || entropy_position != payload->entropy_length)) ||
        !r2_padding_zero(payload->bypass, payload->bypass_length, bypass_position)) return 0;
    return 1;
}

static int r2_decode_side_subframe(const uint8_t *body, size_t body_length, size_t *position,
                                   uint16_t blocksize, uint8_t assignment, unsigned channel,
                                   uint8_t mode, R2_Model *model, R2_Subframe *sub,
                                   size_t *side_bytes_out, uint32_t *entropy_bytes_out,
                                   uint32_t *bypass_bytes_out) {
    size_t bit_position = *position * 8u;
    uint32_t sync, code, wasted_flag;
    if (!r2_bits_read(body, body_length, &bit_position, &sync, 1) || sync != 0 ||
        !r2_bits_read(body, body_length, &bit_position, &code, 6) ||
        !r2_bits_read(body, body_length, &bit_position, &wasted_flag, 1)) return 0;
    memset(sub, 0, sizeof *sub);
    if (code == 0) { sub->type = FLAC__SUBFRAME_TYPE_CONSTANT; sub->order = 0; }
    else if (code == 1) { sub->type = FLAC__SUBFRAME_TYPE_VERBATIM; sub->order = 0; }
    else if (code >= 8 && code <= 12) { sub->type = FLAC__SUBFRAME_TYPE_FIXED; sub->order = (uint8_t)(code - 8); }
    else if (code >= 32 && code <= 63) { sub->type = FLAC__SUBFRAME_TYPE_LPC; sub->order = (uint8_t)(code - 31); }
    else return 0;
    if (wasted_flag == 1) {
        uint32_t zeros = 0, bit;
        do {
            if (zeros >= 31 || !r2_bits_read(body, body_length, &bit_position, &bit, 1)) return 0;
            if (bit == 0) zeros++;
        } while (bit == 0);
        sub->wasted = (uint8_t)(zeros + 1);
    } else if (wasted_flag != 0) return 0;
    unsigned side = (assignment == FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE && channel == 1) ||
                    (assignment == FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE && channel == 0) ||
                    (assignment == FLAC__CHANNEL_ASSIGNMENT_MID_SIDE && channel == 1);
    unsigned bps = 24u + side;
    if (sub->wasted >= bps || sub->order > blocksize) return 0;
    unsigned width = bps - sub->wasted;
    if (sub->type == FLAC__SUBFRAME_TYPE_FIXED || sub->type == FLAC__SUBFRAME_TYPE_LPC)
        for (uint32_t i = 0; i < sub->order; ++i)
            if (!r2_read_signed(body, body_length, &bit_position, &sub->warmup[i], width)) return 0;
    if (sub->type == FLAC__SUBFRAME_TYPE_LPC) {
        uint32_t precision, shift;
        if (!r2_bits_read(body, body_length, &bit_position, &precision, 4) ||
            !r2_bits_read(body, body_length, &bit_position, &shift, 5) || precision == 0) return 0;
        sub->precision = (uint8_t)(precision + 1);
        sub->shift = (int8_t)(shift & 16 ? shift | 0xe0u : shift);
        if (sub->precision < FLAC__MIN_QLP_COEFF_PRECISION ||
            sub->precision > FLAC__MAX_QLP_COEFF_PRECISION ||
            sub->shift < -16 || sub->shift > 15) return 0;
        for (uint32_t i = 0; i < sub->order; ++i)
            if (!r2_read_signed(body, body_length, &bit_position, &sub->coefficients[i], sub->precision)) return 0;
    }
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT || sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        sub->method = 255;
        sub->count = sub->type == FLAC__SUBFRAME_TYPE_CONSTANT ? 1u : blocksize;
        sub->data = calloc(sub->count, sizeof(*sub->data));
        if (!sub->data) return 0;
        for (uint32_t i = 0; i < sub->count; ++i)
            if (!r2_read_signed(body, body_length, &bit_position, &sub->data[i], width)) return 0;
    } else {
        uint32_t method, partition_order;
        if (!r2_bits_read(body, body_length, &bit_position, &method, 2) || method > 1 ||
            !r2_bits_read(body, body_length, &bit_position, &partition_order, 4) ||
            partition_order > MAX_PARTITION) return 0;
        sub->method = (uint8_t)method;
        sub->partition_order = (uint8_t)partition_order;
        sub->partition_count = 1u << partition_order;
        sub->count = blocksize - sub->order;
        unsigned escape = method == 0 ? FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE_ESCAPE_PARAMETER
                                      : FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2_ESCAPE_PARAMETER;
        unsigned parameter_width = method == 0 ? 4u : 5u;
        for (uint32_t p = 0; p < sub->partition_count; ++p) {
            uint32_t parameter;
            if (!r2_bits_read(body, body_length, &bit_position, &parameter, parameter_width)) return 0;
            sub->parameters[p] = (uint8_t)parameter;
            if (parameter == escape) {
                uint32_t raw;
                if (!r2_bits_read(body, body_length, &bit_position, &raw, 5) || raw > 31) return 0;
                sub->raw_widths[p] = (uint8_t)raw;
            } else if (parameter >= (1u << parameter_width)) return 0;
        }
        uint32_t partitions = 1u << partition_order;
        if (blocksize % partitions != 0 || blocksize / partitions < sub->order) return 0;
        sub->data = calloc(sub->count ? sub->count : 1, sizeof(*sub->data));
        if (!sub->data) return 0;
    }
    size_t side_end = (bit_position + 7u) / 8u;
    if (side_end > body_length || !r2_padding_zero(body, side_end, bit_position)) return 0;
    *side_bytes_out = side_end - *position;
    *position = side_end;
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT || sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        *entropy_bytes_out = 0;
        *bypass_bytes_out = 0;
        return 1;
    }
    R2_Cursor lengths = {.data = (uint8_t *)body, .length = body_length, .position = *position};
    uint32_t entropy_bytes, bypass_bytes;
    if (!r2_cursor_u32(&lengths, &entropy_bytes) || !r2_cursor_u32(&lengths, &bypass_bytes) ||
        entropy_bytes > R2_MAX_SUBFRAME_BYTES || bypass_bytes > R2_MAX_SUBFRAME_BYTES ||
        lengths.position > body_length || entropy_bytes > body_length - lengths.position) return 0;
    *entropy_bytes_out = entropy_bytes;
    *bypass_bytes_out = bypass_bytes;
    size_t entropy_start = lengths.position;
    size_t bypass_start = entropy_start + entropy_bytes;
    if (bypass_start > body_length || bypass_bytes > body_length - bypass_start) return 0;
    R2_Payload payload = {.entropy = body + entropy_start, .entropy_length = entropy_bytes,
                          .bypass = body + bypass_start, .bypass_length = bypass_bytes};
    *position = bypass_start + bypass_bytes;
    int ok = mode == 0 ? r2_decode_rice_subframe(sub, &payload) :
             r2_decode_rans_subframe(sub, &payload, model, assignment, channel);
    if (!ok) { free(sub->data); sub->data = NULL; }
    return ok;
}

static int r2_restore_subframe(const R2_Subframe *sub, uint32_t blocksize,
                               uint8_t assignment, unsigned channel, int64_t *values) {
    unsigned side = (assignment == FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE && channel == 1) ||
                    (assignment == FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE && channel == 0) ||
                    (assignment == FLAC__CHANNEL_ASSIGNMENT_MID_SIDE && channel == 1);
    unsigned bps = 24u + side;
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT) {
        for (uint32_t i = 0; i < blocksize; ++i) values[i] = sub->data[0];
    } else if (sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        for (uint32_t i = 0; i < blocksize; ++i) values[i] = sub->data[i];
    } else {
        for (uint32_t i = 0; i < sub->order; ++i) values[i] = sub->warmup[i];
        for (uint32_t i = sub->order; i < blocksize; ++i) {
            __int128 prediction;
            if (sub->type == FLAC__SUBFRAME_TYPE_FIXED) {
                switch (sub->order) {
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
                for (uint32_t j = 0; j < sub->order; ++j)
                    prediction += (__int128)sub->coefficients[j] * values[i - 1 - j];
                if (!floor_pow2_shift(prediction, sub->shift, &prediction)) return 0;
            }
            if (!checked_i64(prediction + sub->data[i - sub->order], &values[i])) return 0;
        }
    }
    if (sub->wasted) {
        for (uint32_t i = 0; i < blocksize; ++i)
            if (!checked_i64((__int128)values[i] * (((__int128)1) << sub->wasted), &values[i])) return 0;
    }
    if (bps >= 63) return 0;
    int64_t minimum = -((int64_t)1 << (bps - 1));
    int64_t maximum = ((int64_t)1 << (bps - 1)) - 1;
    for (uint32_t i = 0; i < blocksize; ++i)
        if (values[i] < minimum || values[i] > maximum) return 0;
    return 1;
}

static int r2_decode_frame(const uint8_t *body, size_t body_length, uint8_t mode,
                           R2_Model *model, FILE *output, R2_Audit *audit,
                           R2_Metrics *metrics) {
    R2_Cursor cursor = {.data = (uint8_t *)body, .length = body_length};
    uint16_t blocksize;
    uint8_t assignment, flags;
    if (!r2_cursor_u16(&cursor, &blocksize) || !r2_cursor_u8(&cursor, &assignment) ||
        !r2_cursor_u8(&cursor, &flags) || flags || blocksize == 0 || assignment > 3) return 0;
    R2_Frame frame = {.blocksize = blocksize, .assignment = assignment};
    size_t position = cursor.position;
    for (unsigned channel = 0; channel < 2; ++channel) {
        size_t side_bytes;
        uint32_t entropy_bytes, bypass_bytes;
        if (!r2_decode_side_subframe(body, body_length, &position, blocksize, assignment,
                                     channel, mode, model, &frame.sub[channel],
                                     &side_bytes,
                                     &entropy_bytes, &bypass_bytes)) {
            r2_free_frame(&frame); return 0;
        }
        metrics->side_bytes += side_bytes;
        if (frame.sub[channel].type != FLAC__SUBFRAME_TYPE_CONSTANT &&
            frame.sub[channel].type != FLAC__SUBFRAME_TYPE_VERBATIM) {
            metrics->predictive_subframes++;
            metrics->entropy_bytes += entropy_bytes;
            metrics->bypass_bytes += bypass_bytes;
        }
    }
    if (position != body_length) {
        r2_free_frame(&frame); return 0;
    }
    int64_t *values[2] = {calloc(blocksize, sizeof(int64_t)), calloc(blocksize, sizeof(int64_t))};
    if (!values[0] || !values[1] || !r2_restore_subframe(&frame.sub[0], blocksize, assignment, 0, values[0]) ||
        !r2_restore_subframe(&frame.sub[1], blocksize, assignment, 1, values[1])) {
        free(values[0]); free(values[1]); r2_free_frame(&frame); return 0;
    }
    for (uint32_t i = 0; i < blocksize; ++i) {
        int64_t left, right;
        switch (assignment) {
            case FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT:
                left = values[0][i]; right = values[1][i]; break;
            case FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE:
                left = values[0][i];
                if (!checked_i64((__int128)values[0][i] - values[1][i], &right)) goto fail;
                break;
            case FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE:
                right = values[1][i];
                if (!checked_i64((__int128)values[1][i] + values[0][i], &left)) goto fail;
                break;
            case FLAC__CHANNEL_ASSIGNMENT_MID_SIDE: {
                int64_t twice;
                if (!checked_i64(2 * (__int128)values[0][i] + (values[1][i] & 1), &twice) ||
                    !checked_i64((__int128)twice + values[1][i], &left) ||
                    !checked_i64((__int128)twice - values[1][i], &right)) goto fail;
                left /= 2; right /= 2;
                break;
            }
            default: goto fail;
        }
        if (!write_s24(output, left) || !write_s24(output, right)) goto fail;
    }
    if (!r2_audit_frame(audit, &frame)) goto fail;
    metrics->frame_count++;
    metrics->frame_bytes += body_length + 4;
    metrics->audit_bytes = audit->bytes;
    free(values[0]); free(values[1]); r2_free_frame(&frame);
    return 1;
fail:
    free(values[0]); free(values[1]); r2_free_frame(&frame);
    return 0;
}

static int r2_open_audit(const char *path, R2_Audit *audit);
static int r2_write_summary(const char *path, uint8_t mode, const R2_Model *model,
                            const R2_Metrics *metrics, uint64_t file_bytes,
                            uint64_t manifest_bytes, uint64_t input_records);

static int r2_read_entropy_header(FILE *input, uint8_t *mode, uint8_t **manifest,
                                  uint64_t *manifest_length, uint64_t *record_count,
                                  R2_Model *model) {
    char magic[8];
    uint8_t profile;
    uint16_t flags;
    uint32_t table_count;
    if (!read_bytes(input, magic, sizeof magic) || memcmp(magic, R2_MAGIC, 8) != 0 ||
        !get_u8(input, mode) || !get_u8(input, &profile) || !get_u16(input, &flags) ||
        !get_u64(input, manifest_length) || !get_u64(input, record_count) ||
        !get_u32(input, &table_count) || profile != R2_PROFILE || flags != 0 ||
        *mode > 1 || *manifest_length > R2_MAX_MANIFEST || table_count > R2_MAX_TABLES)
        return 0;
    if (*mode == 0 && table_count != 0) return 0;
    *manifest = malloc(*manifest_length ? (size_t)*manifest_length : 1);
    if (!*manifest || !read_bytes(input, *manifest, (size_t)*manifest_length)) return 0;
    memset(model, 0, sizeof *model);
    for (unsigned role = 0; role < 4; ++role)
        for (unsigned k = 0; k < 31; ++k)
            for (unsigned context = 0; context < 5; ++context)
                model->index[role][k][context] = -1;
    model->table_count = table_count;
    uint8_t previous_role = 0, previous_k = 0, previous_context = 0;
    int has_previous = 0;
    for (uint32_t ti = 0; ti < table_count; ++ti) {
        R2_Table *table = &model->tables[ti];
        if (!get_u8(input, &table->role) || !get_u8(input, &table->k) ||
            !get_u8(input, &table->context) || table->role >= 4 || table->k >= 31 ||
            table->context >= 5 ||
            (has_previous && r2_table_key_compare(previous_role, previous_k, previous_context,
                                                   table->role, table->k, table->context) >= 0)) return 0;
        uint32_t sum = 0, cumulative = 0;
        for (unsigned symbol = 0; symbol < 17; ++symbol) {
            if (!get_u16(input, &table->freq[symbol])) return 0;
            sum += table->freq[symbol];
            table->cumulative[symbol] = (uint16_t)cumulative;
            for (uint32_t slot = 0; slot < table->freq[symbol]; ++slot) {
                if (cumulative + slot >= R2_SCALE) return 0;
                table->symbol[cumulative + slot] = (uint8_t)symbol;
            }
            cumulative += table->freq[symbol];
        }
        table->cumulative[17] = (uint16_t)cumulative;
        if (sum != R2_SCALE || cumulative != R2_SCALE ||
            model->index[table->role][table->k][table->context] >= 0) return 0;
        model->index[table->role][table->k][table->context] = (int16_t)ti;
        previous_role = table->role; previous_k = table->k; previous_context = table->context;
        has_previous = 1;
    }
    return 1;
}

static int r2_decode(const char *input_path, const char *output_path,
                     const char *audit_path, const char *summary_path) {
    FILE *input = fopen(input_path, "rb");
    FILE *output = NULL;
    R2_Audit audit = {0};
    R2_Model model;
    uint8_t mode, *manifest = NULL;
    uint64_t manifest_length, record_count;
    R2_Metrics metrics = {0};
    if (!input || !r2_read_entropy_header(input, &mode, &manifest, &manifest_length,
                                          &record_count, &model)) {
        r2_fail("invalid round2 header or model table");
        if (input) fclose(input);
        free(manifest); return 2;
    }
    output = fopen(output_path, "wb");
    int audit_enabled = strcmp(audit_path, "-") != 0;
    if (!output || (audit_enabled && !r2_open_audit(audit_path, &audit))) {
        r2_fail("cannot create decoded output");
        if (output) fclose(output);
        if (audit.file) fclose(audit.file);
        fclose(input); free(manifest); return 2;
    }
    for (uint64_t index = 0; index < record_count; ++index) {
        uint32_t body_bytes;
        if (!get_u32(input, &body_bytes) || body_bytes == 0 || body_bytes > R2_MAX_FRAME_BODY) {
            r2_fail("invalid encoded frame length"); goto fail;
        }
        uint8_t *body = malloc(body_bytes);
        if (!body || !read_bytes(input, body, body_bytes)) {
            free(body); r2_fail("truncated encoded frame"); goto fail;
        }
        if (!r2_decode_frame(body, body_bytes, mode, &model, output, &audit, &metrics)) {
            free(body); r2_fail("encoded frame failed side-info or entropy validation"); goto fail;
        }
        free(body);
        metrics.record_count++;
    }
    if (fgetc(input) != EOF || ferror(input) || fflush(output) != 0 ||
        (audit_enabled && fflush(audit.file) != 0)) {
        r2_fail("encoded file has trailing bytes or output flush failed"); goto fail;
    }
    metrics.audit_bytes = audit.bytes;
    off_t output_bytes = ftello(output);
    off_t input_bytes = ftello(input);
    int ok = output_bytes >= 0 && input_bytes >= 0 && fclose(output) == 0 &&
             (!audit.file || fclose(audit.file) == 0) &&
             fclose(input) == 0 && r2_write_summary(summary_path, mode, &model, &metrics,
                                                     (uint64_t)input_bytes, manifest_length, record_count);
    free(manifest);
    if (!ok) { remove(output_path); remove(audit_path); remove(summary_path); return 2; }
    return 0;
fail:
    fclose(output); if (audit.file) fclose(audit.file); fclose(input); free(manifest);
    remove(output_path); remove(audit_path); remove(summary_path);
    return 2;
}

static int r2_open_audit(const char *path, R2_Audit *audit) {
    memset(audit, 0, sizeof *audit);
    audit->file = fopen(path, "wb");
    if (!audit->file || !write_bytes(audit->file, "I77AUD02", 8)) {
        if (audit->file) fclose(audit->file);
        audit->file = NULL;
        return 0;
    }
    audit->bytes = 8;
    return 1;
}

static int r2_write_summary(const char *path, uint8_t mode, const R2_Model *model,
                            const R2_Metrics *metrics, uint64_t file_bytes,
                            uint64_t manifest_bytes, uint64_t input_records) {
    FILE *summary = fopen(path, "wb");
    if (!summary) return 0;
    int ok = fprintf(summary,
        "{\"format\":\"issue77-round2-summary-v1\",\"mode\":%u,"
        "\"recordCount\":%" PRIu64 ",\"frameCount\":%" PRIu64 ","
        "\"predictiveSubframes\":%" PRIu64 ","
        "\"manifestBytes\":%" PRIu64 ",\"tableCount\":%u,"
        "\"tableBytes\":%" PRIu64 ",\"sideBytes\":%" PRIu64 ","
        "\"entropyBytes\":%" PRIu64 ",\"bypassBytes\":%" PRIu64 ","
        "\"frameBytes\":%" PRIu64 ",\"fileBytes\":%" PRIu64 ","
        "\"auditBytes\":%" PRIu64 ",\"inputRecordCount\":%" PRIu64 "}\n",
        mode, metrics->record_count, metrics->frame_count, metrics->predictive_subframes,
        manifest_bytes, model->table_count,
        (uint64_t)model->table_count * (3u + 17u * 2u), metrics->side_bytes,
        metrics->entropy_bytes, metrics->bypass_bytes, metrics->frame_bytes, file_bytes,
        metrics->audit_bytes, input_records);
    if (fclose(summary) != 0) ok = 0;
    return ok > 0;
}

static int r2_encode(const char *input_path, const char *output_path,
                     const char *audit_path, const char *summary_path, uint8_t mode) {
    R2_Rsd input;
    R2_Model model;
    FILE *output = NULL;
    R2_Audit audit = {0};
    R2_Metrics metrics = {0};
    if (!r2_open_rsd(input_path, &input)) { r2_fail("cannot open RSD input"); return 2; }
    if (mode == 1) {
        if (!r2_build_model(&input, &model)) {
            r2_fail("cannot build bounded per-stem context model");
            r2_close_rsd(&input); return 2;
        }
    } else {
        memset(&model, 0, sizeof model);
        if (!r2_rewind_rsd(&input)) { r2_close_rsd(&input); return 2; }
    }
    output = fopen(output_path, "wb");
    if (!output || !r2_write_header(output, mode, &input, &model) || !r2_open_audit(audit_path, &audit)) {
        r2_fail("cannot create round2 output");
        if (output) fclose(output);
        r2_close_rsd(&input);
        return 2;
    }
    uint64_t packed = 0, offset = 0;
    uint32_t chunk = 0;
    int has_previous = 0;
    for (uint64_t index = 0; index < input.record_count; ++index) {
        R2_Frame frame = {0};
        if (!r2_read_rsd_frame(input.file, &frame) ||
            !r2_validate_sequence(&frame, index, &packed, &chunk, &offset, &has_previous) ||
            !r2_encode_frame(&frame, &model, mode, output, &metrics) ||
            !r2_audit_frame(&audit, &frame)) {
            r2_fail("RSD frame rejected during encoding");
            r2_free_frame(&frame); fclose(output); fclose(audit.file); r2_close_rsd(&input);
            remove(output_path); remove(audit_path); return 2;
        }
        metrics.record_count++;
        r2_free_frame(&frame);
    }
    if (fgetc(input.file) != EOF || ferror(input.file) || fflush(output) != 0 || fflush(audit.file) != 0) {
        r2_fail("RSD has trailing bytes or output flush failed");
        fclose(output); fclose(audit.file); r2_close_rsd(&input);
        remove(output_path); remove(audit_path); return 2;
    }
    metrics.audit_bytes = audit.bytes;
    off_t end = ftello(output);
    int ok = end >= 0 && fclose(output) == 0 && fclose(audit.file) == 0 &&
             r2_write_summary(summary_path, mode, &model, &metrics, (uint64_t)end,
                              input.manifest_length, input.record_count);
    r2_close_rsd(&input);
    if (!ok) { remove(output_path); remove(audit_path); remove(summary_path); return 2; }
    return 0;
}

static void r2_usage(const char *program) {
    fprintf(stderr,
            "usage:\n  %s encode INPUT_RSD OUTPUT AUDIT SUMMARY MODE(0|1)\n"
            "  %s decode INPUT OUTPUT_RAW AUDIT SUMMARY\n", program, program);
}

#ifndef I77_ROUND2_NO_MAIN
int main(int argc, char **argv) {
    if (argc == 7 && strcmp(argv[1], "encode") == 0) {
        char *end = NULL;
        unsigned long mode = strtoul(argv[6], &end, 10);
        if (!end || *end != '\0' || mode > 1) return 2;
        return r2_encode(argv[2], argv[3], argv[4], argv[5], (uint8_t)mode);
    }
    if (argc == 6 && strcmp(argv[1], "decode") == 0)
        return r2_decode(argv[2], argv[3], argv[4], argv[5]);
    if (argc == 5 && strcmp(argv[1], "decode") == 0) {
        char audit_path[PATH_MAX];
        if (snprintf(audit_path, sizeof audit_path, "%s.audit", argv[4]) >= (int)sizeof audit_path) return 2;
        return r2_decode(argv[2], argv[3], audit_path, argv[4]);
    }
    r2_usage(argv[0]);
    return 2;
}
#endif
