/*
 * Issue #77 round 3: bounded adaptive Q20 FIR correction over round-1
 * residuals.  The round-2 codec is included read-only for its record parser,
 * Rice/rANS implementation, and checked PCM restoration.
 */
#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L
#define I77_ROUND2_NO_MAIN
#include "../../round-02/native/round2.c"
#undef I77_ROUND2_NO_MAIN

#include <inttypes.h>
#include <sys/types.h>

#define R3_MAGIC "I77FIR03"
#define R3_SHAPE_PROFILE 1u
#define R3_MAX_PROFILE 4u
#define R3_AUDIT_MAGIC "I77FIRA3"
#define R3_Q20 (INT64_C(1) << 20)
#define R3_Q20_LIMIT R3_Q20

typedef struct {
    uint64_t prediction_clamp;
    uint64_t coefficient_clamp;
    uint64_t modular_wrap;
    uint64_t updates;
} R3_Counters;

typedef struct {
    FILE *file;
    uint64_t bytes;
} R3_Audit;

typedef struct {
    unsigned m;
    unsigned b;
    int64_t coefficient[32];
    int32_t history[32];
    unsigned head;
    __uint128_t energy;
} R3_State;

static __uint128_t r3_square_i32(int32_t value) {
    int64_t wide = value;
    uint64_t magnitude = (uint64_t)(wide < 0 ? -wide : wide);
    return (__uint128_t)magnitude * magnitude;
}

static int r3_profile(uint8_t profile, unsigned *m, unsigned *b) {
    if (profile > R3_MAX_PROFILE) return 0;
    if (profile == 0) {
        *m = 0;
        *b = 0;
    } else {
        *m = profile <= 2 ? 8u : 32u;
        *b = (profile == 2 || profile == 4) ? 5u : 3u;
    }
    return 1;
}

static int32_t r3_u32_signed(uint32_t value) {
    return value < UINT32_C(0x80000000) ? (int32_t)value :
           (int32_t)((int64_t)value - (INT64_C(1) << 32));
}

static int64_t r3_floor_q20(int64_t value) {
    int64_t quotient = value / R3_Q20;
    int64_t remainder = value % R3_Q20;
    if (remainder < 0) quotient--;
    return quotient;
}

static unsigned r3_energy_log2(__uint128_t energy) {
    __uint128_t value = energy - 1;
    unsigned result = 0;
    while (value != 0) {
        value >>= 1;
        result++;
    }
    return result;
}

static int r3_state_init(R3_State *state, uint8_t profile) {
    memset(state, 0, sizeof *state);
    if (!r3_profile(profile, &state->m, &state->b)) return 0;
    state->energy = 1;
    return 1;
}

static int r3_predict(R3_State *state, int32_t *prediction, R3_Counters *counters) {
    int64_t sum = 0;
    for (unsigned j = 0; j < state->m; ++j) {
        unsigned index = (state->head + j) % state->m;
        sum += state->coefficient[j] * (int64_t)state->history[index];
    }
    int64_t value = r3_floor_q20(sum);
    if (value < INT32_MIN) {
        value = INT32_MIN;
        if (counters) counters->prediction_clamp++;
    } else if (value > INT32_MAX) {
        value = INT32_MAX;
        if (counters) counters->prediction_clamp++;
    }
    *prediction = (int32_t)value;
    return 1;
}

static void r3_update(R3_State *state, int64_t difference, R3_Counters *counters) {
    unsigned ell = r3_energy_log2(state->energy);
    __int128 denominator = (__int128)1 << (ell + state->b);
    for (unsigned j = 0; j < state->m; ++j) {
        unsigned index = (state->head + j) % state->m;
        __int128 numerator = (__int128)difference * state->history[index] * R3_Q20;
        __int128 delta = numerator / denominator;
        __int128 coefficient = (__int128)state->coefficient[j] + delta;
        if (coefficient < -R3_Q20_LIMIT) {
            coefficient = -R3_Q20_LIMIT;
            if (counters) counters->coefficient_clamp++;
        } else if (coefficient > R3_Q20_LIMIT) {
            coefficient = R3_Q20_LIMIT;
            if (counters) counters->coefficient_clamp++;
        }
        state->coefficient[j] = (int64_t)coefficient;
    }
    if (counters) counters->updates++;
}

static int r3_transform_subframe(R2_Subframe *sub, uint8_t profile, int inverse,
                                 R3_Counters *counters) {
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT ||
        sub->type == FLAC__SUBFRAME_TYPE_VERBATIM || profile == 0) return 1;
    R3_State state;
    if (!r3_state_init(&state, profile)) return 0;
    for (uint32_t t = 0; t < sub->count; ++t) {
        int32_t prediction;
        if (!r3_predict(&state, &prediction, counters)) return 0;
        int32_t input = sub->data[t];
        int32_t original;
        int64_t difference;
        if (inverse) {
            uint32_t sum = (uint32_t)input + (uint32_t)prediction;
            original = r3_u32_signed(sum);
            difference = (int64_t)original - prediction;
        } else {
            original = input;
            difference = (int64_t)original - prediction;
            uint32_t error = (uint32_t)original - (uint32_t)prediction;
            sub->data[t] = r3_u32_signed(error);
        }
        if (difference < INT32_MIN || difference > INT32_MAX) {
            if (counters) counters->modular_wrap++;
        }
        if (inverse) sub->data[t] = original;
        if (state.m && (t & 3u) == 3u) r3_update(&state, difference, counters);
        if (state.m) {
            unsigned next_head = (state.head + state.m - 1u) % state.m;
            int64_t old = state.history[next_head];
            state.energy -= r3_square_i32((int32_t)old);
            state.head = next_head;
            state.history[state.head] = original;
            state.energy += r3_square_i32(original);
        }
    }
    return 1;
}

static int r3_counters_equal(const R3_Counters *a, const R3_Counters *b) {
    return a->prediction_clamp == b->prediction_clamp &&
           a->coefficient_clamp == b->coefficient_clamp &&
           a->modular_wrap == b->modular_wrap && a->updates == b->updates;
}

static void r3_counters_add(R3_Counters *total, const R3_Counters *part) {
    total->prediction_clamp += part->prediction_clamp;
    total->coefficient_clamp += part->coefficient_clamp;
    total->modular_wrap += part->modular_wrap;
    total->updates += part->updates;
}

static int r3_choose_k(R2_Subframe *sub) {
    for (uint32_t p = 0; p < sub->partition_count; ++p) {
        uint32_t start, count;
        if (!r2_partition_bounds(sub, p, &start, &count)) return 0;
        unsigned low = 0, high = 30;
        while (low < high) {
            unsigned middle = low + (high - low) / 2u;
            uint64_t half_sum = 0;
            for (uint32_t i = 0; i < count; ++i) {
                uint32_t folded;
                if (!r2_fold(sub->data[start + i], &folded)) return 0;
                uint32_t quotient = folded >> middle;
                half_sum += ((uint64_t)quotient + 1u) / 2u;
            }
            if (half_sum <= count) high = middle;
            else low = middle + 1u;
        }
        sub->parameters[p] = (uint8_t)low;
        sub->raw_widths[p] = 0;
    }
    sub->method = FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2;
    return 1;
}

static int r3_prepare_subframe(R2_Subframe *sub, uint8_t profile, R3_Counters *counters) {
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT ||
        sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) return 1;
    if (!r3_transform_subframe(sub, profile, 0, counters)) return 0;
    return r3_choose_k(sub);
}

static int r3_prepare_frame(R2_Frame *frame, uint8_t profile, R3_Counters *counters) {
    return r3_prepare_subframe(&frame->sub[0], profile, counters) &&
           r3_prepare_subframe(&frame->sub[1], profile, counters);
}

static int r3_build_model(R2_Rsd *input, R2_Model *model, uint8_t profile) {
    memset(model, 0, sizeof *model);
    if (!r2_rewind_rsd(input)) return 0;
    uint64_t packed = 0, offset = 0;
    uint32_t chunk = 0;
    int has_previous = 0;
    for (uint64_t index = 0; index < input->record_count; ++index) {
        R2_Frame frame = {0};
        if (!r2_read_rsd_frame(input->file, &frame) ||
            !r2_validate_sequence(&frame, index, &packed, &chunk, &offset, &has_previous) ||
            !r3_prepare_frame(&frame, profile, NULL) ||
            !r2_subframe_hist(model, &frame.sub[0], frame.assignment, 0) ||
            !r2_subframe_hist(model, &frame.sub[1], frame.assignment, 1)) {
            r2_free_frame(&frame);
            return 0;
        }
        r2_free_frame(&frame);
    }
    int ch = fgetc(input->file);
    if (ch != EOF || ferror(input->file) || !r2_normalize_model(model)) return 0;
    return r2_rewind_rsd(input);
}

static int r3_write_header(FILE *output, uint8_t mode, uint8_t profile,
                           const R2_Rsd *input, const R2_Model *model) {
    if (!write_bytes(output, R3_MAGIC, 8) || !put_u8(output, mode) ||
        !put_u8(output, R3_SHAPE_PROFILE) || !put_u8(output, profile) ||
        !put_u8(output, 0) || !put_u64(output, input->manifest_length) ||
        !put_u64(output, input->record_count) ||
        !put_u32(output, mode ? model->table_count : 0) ||
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

static int r3_audit_u8(R3_Audit *audit, uint8_t value) {
    if (!put_u8(audit->file, value)) return 0;
    audit->bytes++;
    return 1;
}

static int r3_audit_u16(R3_Audit *audit, uint16_t value) {
    if (!put_u16(audit->file, value)) return 0;
    audit->bytes += 2;
    return 1;
}

static int r3_audit_u32(R3_Audit *audit, uint32_t value) {
    if (!put_u32(audit->file, value)) return 0;
    audit->bytes += 4;
    return 1;
}

static int r3_audit_i32(R3_Audit *audit, int32_t value) {
    return r3_audit_u32(audit, (uint32_t)value);
}

/* Audit A intentionally omits the replaced Rice method, k, and raw widths. */
static int r3_audit_original_frame(R3_Audit *audit, const R2_Frame *frame) {
    if (!audit || !audit->file) return 1;
    if (!r3_audit_u16(audit, frame->blocksize) ||
        !r3_audit_u8(audit, frame->assignment) || !r3_audit_u8(audit, 0)) return 0;
    for (unsigned channel = 0; channel < 2; ++channel) {
        const R2_Subframe *sub = &frame->sub[channel];
        if (!r3_audit_u8(audit, sub->type) || !r3_audit_u8(audit, sub->wasted) ||
            !r3_audit_u8(audit, sub->order) || !r3_audit_u8(audit, sub->precision) ||
            !r3_audit_u8(audit, (uint8_t)sub->shift) ||
            !r3_audit_u8(audit, sub->partition_order) || !r3_audit_u8(audit, 0) ||
            !r3_audit_u32(audit, sub->count)) return 0;
        for (uint32_t i = 0; i < sub->order; ++i)
            if (!r3_audit_i32(audit, sub->warmup[i])) return 0;
        if (sub->type == FLAC__SUBFRAME_TYPE_LPC)
            for (uint32_t i = 0; i < sub->order; ++i)
                if (!r3_audit_i32(audit, sub->coefficients[i])) return 0;
        for (uint32_t i = 0; i < sub->count; ++i)
            if (!r3_audit_i32(audit, sub->data[i])) return 0;
    }
    return 1;
}

static int r3_open_original_audit(const char *path, R3_Audit *audit) {
    memset(audit, 0, sizeof *audit);
    if (strcmp(path, "-") == 0) return 1;
    audit->file = fopen(path, "wb");
    if (!audit->file || !write_bytes(audit->file, R3_AUDIT_MAGIC, 8)) {
        if (audit->file) fclose(audit->file);
        audit->file = NULL;
        return 0;
    }
    audit->bytes = 8;
    return 1;
}

static int r3_open_coded_audit(const char *path, R2_Audit *audit) {
    memset(audit, 0, sizeof *audit);
    if (strcmp(path, "-") == 0) return 1;
    return r2_open_audit(path, audit);
}

static void r3_remove_path(const char *path) {
    if (strcmp(path, "-") != 0) remove(path);
}

static int r3_copy_subframe_data(const R2_Subframe *sub, int32_t **copy) {
    *copy = malloc((sub->count ? sub->count : 1u) * sizeof **copy);
    if (!*copy) return 0;
    if (sub->count) memcpy(*copy, sub->data, sub->count * sizeof **copy);
    return 1;
}

static int r3_validate_coded_subframe(const R2_Subframe *sub) {
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT ||
        sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) return 1;
    if (sub->method != FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2) return 0;
    for (uint32_t p = 0; p < sub->partition_count; ++p)
        if (sub->parameters[p] > 30 || sub->raw_widths[p] != 0) return 0;
    return 1;
}

static int r3_read_header(FILE *input, uint8_t *mode, uint8_t *profile,
                          uint8_t **manifest, uint64_t *manifest_length,
                          uint64_t *record_count, R2_Model *model) {
    char magic[8];
    uint8_t shape, reserved;
    uint32_t table_count;
    if (!read_bytes(input, magic, 8) || memcmp(magic, R3_MAGIC, 8) != 0 ||
        !get_u8(input, mode) || !get_u8(input, &shape) || !get_u8(input, profile) ||
        !get_u8(input, &reserved) || !get_u64(input, manifest_length) ||
        !get_u64(input, record_count) || !get_u32(input, &table_count) ||
        shape != R3_SHAPE_PROFILE || reserved != 0 || *mode > 1 ||
        !r3_profile(*profile, &(unsigned){0}, &(unsigned){0}) ||
        *manifest_length > R2_MAX_MANIFEST || table_count > R2_MAX_TABLES ||
        (*mode == 0 && table_count != 0)) return 0;
    *manifest = malloc(*manifest_length ? (size_t)*manifest_length : 1u);
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
        previous_role = table->role;
        previous_k = table->k;
        previous_context = table->context;
        has_previous = 1;
    }
    return 1;
}

static int r3_decode_frame(const uint8_t *body, size_t body_length, uint8_t mode,
                           uint8_t profile, R2_Model *model, FILE *output,
                           R3_Audit *original_audit, R2_Audit *coded_audit,
                           R2_Metrics *metrics, R3_Counters *counters) {
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
                                     &side_bytes, &entropy_bytes, &bypass_bytes) ||
            !r3_validate_coded_subframe(&frame.sub[channel])) {
            r2_free_frame(&frame);
            return 0;
        }
        metrics->side_bytes += side_bytes;
        if (frame.sub[channel].type != FLAC__SUBFRAME_TYPE_CONSTANT &&
            frame.sub[channel].type != FLAC__SUBFRAME_TYPE_VERBATIM) {
            metrics->predictive_subframes++;
            metrics->entropy_bytes += entropy_bytes;
            metrics->bypass_bytes += bypass_bytes;
        }
    }
    if (position != body_length || !r2_audit_frame(coded_audit, &frame)) {
        r2_free_frame(&frame);
        return 0;
    }
    for (unsigned channel = 0; channel < 2; ++channel)
        if (!r3_transform_subframe(&frame.sub[channel], profile, 1, counters)) {
            r2_free_frame(&frame);
            return 0;
        }
    if (!r3_audit_original_frame(original_audit, &frame)) {
        r2_free_frame(&frame);
        return 0;
    }
    int64_t *values[2] = {calloc(blocksize, sizeof **values), calloc(blocksize, sizeof **values)};
    if (!values[0] || !values[1] || !r2_restore_subframe(&frame.sub[0], blocksize, assignment, 0, values[0]) ||
        !r2_restore_subframe(&frame.sub[1], blocksize, assignment, 1, values[1])) goto fail;
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
    metrics->frame_count++;
    metrics->frame_bytes += body_length + 4;
    free(values[0]); free(values[1]);
    r2_free_frame(&frame);
    return 1;
fail:
    free(values[0]); free(values[1]);
    r2_free_frame(&frame);
    return 0;
}

static int r3_write_summary(const char *path, uint8_t mode, uint8_t profile,
                            const R2_Model *model, const R2_Metrics *metrics,
                            const R3_Counters *counters, uint64_t file_bytes,
                            uint64_t original_audit_bytes, uint64_t manifest_bytes,
                            uint64_t input_records) {
    FILE *summary = fopen(path, "wb");
    if (!summary) return 0;
    int ok = fprintf(summary,
        "{\"format\":\"issue77-round3-summary-v1\",\"mode\":%u,"
        "\"predictorProfile\":%u,\"recordCount\":%" PRIu64 ","
        "\"frameCount\":%" PRIu64 ",\"predictiveSubframes\":%" PRIu64 ","
        "\"manifestBytes\":%" PRIu64 ",\"tableCount\":%u,\"tableBytes\":%" PRIu64 ","
        "\"sideBytes\":%" PRIu64 ",\"entropyBytes\":%" PRIu64 ","
        "\"bypassBytes\":%" PRIu64 ",\"frameBytes\":%" PRIu64 ","
        "\"fileBytes\":%" PRIu64 ",\"auditBytes\":%" PRIu64 ","
        "\"originalAuditBytes\":%" PRIu64 ",\"predictionClamp\":%" PRIu64 ","
        "\"coefficientClamp\":%" PRIu64 ",\"modularWrap\":%" PRIu64 ","
        "\"updates\":%" PRIu64 ",\"inputRecordCount\":%" PRIu64 "}\n",
        mode, profile, metrics->record_count, metrics->frame_count,
        metrics->predictive_subframes, manifest_bytes, model->table_count,
        (uint64_t)model->table_count * 37u, metrics->side_bytes,
        metrics->entropy_bytes, metrics->bypass_bytes, metrics->frame_bytes,
        file_bytes, metrics->audit_bytes, original_audit_bytes,
        counters->prediction_clamp, counters->coefficient_clamp,
        counters->modular_wrap, counters->updates, input_records);
    if (fclose(summary) != 0) ok = 0;
    return ok > 0;
}

static int r3_decode(const char *input_path, const char *output_path,
                     const char *original_audit_path, const char *coded_audit_path,
                     const char *summary_path) {
    FILE *input = fopen(input_path, "rb");
    FILE *output = NULL;
    R3_Audit original_audit = {0};
    R2_Audit coded_audit = {0};
    R2_Model model;
    uint8_t mode, profile, *manifest = NULL;
    uint64_t manifest_length, record_count;
    R2_Metrics metrics = {0};
    R3_Counters counters = {0};
    if (!input || !r3_read_header(input, &mode, &profile, &manifest, &manifest_length,
                                  &record_count, &model)) {
        r2_fail("invalid round3 header or model table");
        if (input) fclose(input);
        free(manifest);
        return 2;
    }
    output = fopen(output_path, "wb");
    if (!output || !r3_open_original_audit(original_audit_path, &original_audit) ||
        !r3_open_coded_audit(coded_audit_path, &coded_audit)) {
        r2_fail("cannot create round3 decoded outputs");
        if (output) fclose(output);
        if (original_audit.file) fclose(original_audit.file);
        if (coded_audit.file) fclose(coded_audit.file);
        fclose(input); free(manifest);
        return 2;
    }
    for (uint64_t index = 0; index < record_count; ++index) {
        uint32_t body_bytes;
        if (!get_u32(input, &body_bytes) || body_bytes == 0 || body_bytes > R2_MAX_FRAME_BODY) {
            r2_fail("invalid round3 frame length"); goto fail;
        }
        uint8_t *body = malloc(body_bytes);
        if (!body || !read_bytes(input, body, body_bytes)) {
            free(body); r2_fail("truncated round3 frame"); goto fail;
        }
        int ok = r3_decode_frame(body, body_bytes, mode, profile, &model, output,
                                 &original_audit, &coded_audit, &metrics, &counters);
        free(body);
        if (!ok) { r2_fail("round3 frame failed validation"); goto fail; }
        metrics.record_count++;
    }
    if (fgetc(input) != EOF || ferror(input) || fflush(output) != 0 ||
        (original_audit.file && fflush(original_audit.file) != 0) ||
        (coded_audit.file && fflush(coded_audit.file) != 0)) {
        r2_fail("round3 trailing bytes or output flush failed"); goto fail;
    }
    metrics.audit_bytes = coded_audit.bytes;
    off_t output_bytes = ftello(output);
    off_t input_bytes = ftello(input);
    int ok = output_bytes >= 0 && input_bytes >= 0 && fclose(output) == 0 &&
             (!original_audit.file || fclose(original_audit.file) == 0) &&
             (!coded_audit.file || fclose(coded_audit.file) == 0) &&
             fclose(input) == 0 &&
             r3_write_summary(summary_path, mode, profile, &model, &metrics, &counters,
                              (uint64_t)input_bytes, original_audit.bytes,
                              manifest_length, record_count);
    free(manifest);
    if (!ok) return 2;
    return 0;
fail:
    fclose(output); if (original_audit.file) fclose(original_audit.file);
    if (coded_audit.file) fclose(coded_audit.file);
    fclose(input);
    free(manifest);
    remove(output_path); r3_remove_path(original_audit_path); r3_remove_path(coded_audit_path); remove(summary_path);
    return 2;
}

static int r3_encode(const char *input_path, const char *output_path,
                     const char *original_audit_path, const char *coded_audit_path,
                     const char *summary_path, uint8_t mode, uint8_t profile) {
    R2_Rsd input;
    R2_Model model;
    FILE *output = NULL;
    R3_Audit original_audit = {0};
    R2_Audit coded_audit = {0};
    R2_Metrics metrics = {0};
    R3_Counters counters = {0};
    if (!r3_profile(profile, &(unsigned){0}, &(unsigned){0}) ||
        !r2_open_rsd(input_path, &input)) {
        r2_fail("cannot open round3 RSD input");
        return 2;
    }
    if (mode == 1) {
        if (!r3_build_model(&input, &model, profile)) {
            r2_fail("cannot build round3 per-stem context model");
            r2_close_rsd(&input); return 2;
        }
    } else {
        memset(&model, 0, sizeof model);
        if (!r2_rewind_rsd(&input)) { r2_close_rsd(&input); return 2; }
    }
    output = fopen(output_path, "wb");
    if (!output || !r3_write_header(output, mode, profile, &input, &model) ||
        !r3_open_original_audit(original_audit_path, &original_audit) ||
        !r3_open_coded_audit(coded_audit_path, &coded_audit)) {
        r2_fail("cannot create round3 output");
        if (output) fclose(output);
        if (original_audit.file) fclose(original_audit.file);
        if (coded_audit.file) fclose(coded_audit.file);
        r2_close_rsd(&input);
        return 2;
    }
    uint64_t packed = 0, offset = 0;
    uint32_t chunk = 0;
    int has_previous = 0;
    for (uint64_t index = 0; index < input.record_count; ++index) {
        R2_Frame frame = {0};
        int32_t *original[2] = {NULL, NULL};
        R3_Counters frame_counters = {0};
        if (!r2_read_rsd_frame(input.file, &frame) ||
            !r2_validate_sequence(&frame, index, &packed, &chunk, &offset, &has_previous) ||
            !r3_copy_subframe_data(&frame.sub[0], &original[0]) ||
            !r3_copy_subframe_data(&frame.sub[1], &original[1]) ||
            !r3_prepare_frame(&frame, profile, &frame_counters) ||
            !r2_encode_frame(&frame, &model, mode, output, &metrics) ||
            !r2_audit_frame(&coded_audit, &frame)) {
            r2_fail("RSD frame rejected during round3 encoding");
            free(original[0]); free(original[1]); r2_free_frame(&frame);
            fclose(output); if (original_audit.file) fclose(original_audit.file);
            if (coded_audit.file) fclose(coded_audit.file);
            r2_close_rsd(&input);
            remove(output_path); r3_remove_path(original_audit_path); r3_remove_path(coded_audit_path); remove(summary_path);
            return 2;
        }
        R2_Frame restored = frame;
        int32_t *recovered[2] = {NULL, NULL};
        R3_Counters inverse_counters = {0};
        if (!r3_copy_subframe_data(&frame.sub[0], &recovered[0]) ||
            !r3_copy_subframe_data(&frame.sub[1], &recovered[1])) {
            free(original[0]); free(original[1]); free(recovered[0]); free(recovered[1]);
            r2_free_frame(&frame); fclose(output); if (original_audit.file) fclose(original_audit.file);
            if (coded_audit.file) fclose(coded_audit.file);
            r2_close_rsd(&input); remove(output_path); r3_remove_path(original_audit_path);
            r3_remove_path(coded_audit_path); remove(summary_path); return 2;
        }
        restored.sub[0].data = recovered[0];
        restored.sub[1].data = recovered[1];
        if (!r3_transform_subframe(&restored.sub[0], profile, 1, &inverse_counters) ||
            !r3_transform_subframe(&restored.sub[1], profile, 1, &inverse_counters) ||
            memcmp(original[0], recovered[0], frame.sub[0].count * sizeof **original) != 0 ||
            memcmp(original[1], recovered[1], frame.sub[1].count * sizeof **original) != 0 ||
            !r3_counters_equal(&frame_counters, &inverse_counters) ||
            !r3_audit_original_frame(&original_audit, &restored)) {
            free(original[0]); free(original[1]); free(recovered[0]); free(recovered[1]);
            r2_free_frame(&frame); fclose(output); if (original_audit.file) fclose(original_audit.file);
            if (coded_audit.file) fclose(coded_audit.file);
            r2_close_rsd(&input); remove(output_path); r3_remove_path(original_audit_path);
            r3_remove_path(coded_audit_path); remove(summary_path); return 2;
        }
        r3_counters_add(&counters, &frame_counters);
        free(original[0]); free(original[1]); free(recovered[0]); free(recovered[1]);
        r2_free_frame(&frame);
        metrics.record_count++;
    }
    if (fgetc(input.file) != EOF || ferror(input.file) || fflush(output) != 0 ||
        (original_audit.file && fflush(original_audit.file) != 0) ||
        (coded_audit.file && fflush(coded_audit.file) != 0)) {
        r2_fail("RSD has trailing bytes or round3 output flush failed");
        fclose(output); if (original_audit.file) fclose(original_audit.file);
        if (coded_audit.file) fclose(coded_audit.file);
        r2_close_rsd(&input);
        remove(output_path); r3_remove_path(original_audit_path); r3_remove_path(coded_audit_path); remove(summary_path);
        return 2;
    }
    metrics.audit_bytes = coded_audit.bytes;
    off_t end = ftello(output);
    int ok = end >= 0 && fclose(output) == 0 &&
             (!original_audit.file || fclose(original_audit.file) == 0) &&
             (!coded_audit.file || fclose(coded_audit.file) == 0) &&
             r3_write_summary(summary_path, mode, profile, &model, &metrics, &counters,
                              (uint64_t)end, original_audit.bytes, input.manifest_length,
                              input.record_count);
    r2_close_rsd(&input);
    if (!ok) {
        remove(output_path); r3_remove_path(original_audit_path); r3_remove_path(coded_audit_path); remove(summary_path);
        return 2;
    }
    return 0;
}

#ifndef I77_ROUND3_NO_MAIN
static void r3_usage(const char *program) {
    fprintf(stderr,
            "usage:\n  %s encode INPUT_RSD OUTPUT ORIGINAL_AUDIT CODED_AUDIT SUMMARY MODE(0|1) PROFILE(0..4)\n"
            "  %s decode INPUT OUTPUT_RAW ORIGINAL_AUDIT CODED_AUDIT SUMMARY\n", program, program);
}

int main(int argc, char **argv) {
    if (argc == 9 && strcmp(argv[1], "encode") == 0) {
        char *end_mode = NULL, *end_profile = NULL;
        unsigned long mode = strtoul(argv[7], &end_mode, 10);
        unsigned long profile = strtoul(argv[8], &end_profile, 10);
        if (!end_mode || *end_mode != '\0' || mode > 1 || !end_profile ||
            *end_profile != '\0' || profile > R3_MAX_PROFILE) return 2;
        return r3_encode(argv[2], argv[3], argv[4], argv[5], argv[6],
                         (uint8_t)mode, (uint8_t)profile);
    }
    if (argc == 7 && strcmp(argv[1], "decode") == 0)
        return r3_decode(argv[2], argv[3], argv[4], argv[5], argv[6]);
    r3_usage(argv[0]);
    return 2;
}
#endif
