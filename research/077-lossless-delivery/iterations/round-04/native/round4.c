/* Issue #77 round 4: charged offline cross-channel residual prediction. */
#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L
#define I77_ROUND3_NO_MAIN
#include "../../round-03/native/round3.c"
#undef I77_ROUND3_NO_MAIN

#include <math.h>
#include <sys/types.h>

#define R4_MAGIC "I77XCH04"
#define R4_SHAPE_PROFILE 1u
#define R4_MAX_PROFILE 2u
#define R4_Q12 4096
#define R4_COEFF_LIMIT 16384

typedef struct {
    uint64_t disabled_frames;
    uint64_t reference0_frames;
    uint64_t reference1_frames;
    uint64_t coefficient_bytes;
    uint64_t prediction_clamp;
    uint64_t modular_wrap;
    uint64_t fit_degenerate;
    uint64_t fit_failures;
    uint64_t coefficient_clipping;
} R4_Counters;

typedef struct {
    unsigned taps;
    int lags[5];
    int valid;
    int degenerate;
    int failure;
    int16_t q[5];
    unsigned clipped;
} R4_Fit;

typedef struct {
    uint8_t selector;
    int16_t q[5];
    unsigned taps;
    uint64_t rice_bytes;
} R4_Plan;

static int r4_profile(uint8_t profile, unsigned *taps, int lags[5]) {
    if (profile > R4_MAX_PROFILE) return 0;
    if (profile == 0) {
        *taps = 0;
        return 1;
    }
    if (profile == 1) {
        *taps = 1;
        lags[0] = 0;
    } else {
        *taps = 5;
        lags[0] = -2; lags[1] = -1; lags[2] = 0; lags[3] = 1; lags[4] = 2;
    }
    return 1;
}

static int r4_predictive(const R2_Subframe *sub) {
    return (sub->type == FLAC__SUBFRAME_TYPE_FIXED ||
            sub->type == FLAC__SUBFRAME_TYPE_LPC);
}

static int r4_eligible(const R2_Subframe *sub) {
    return r4_predictive(sub) && sub->count != 0;
}

static int64_t r4_floor_q12(int64_t value) {
    int64_t quotient = value / R4_Q12;
    int64_t remainder = value % R4_Q12;
    if (remainder < 0) quotient--;
    return quotient;
}

static int r4_feature(const R2_Subframe *reference, const R2_Subframe *target,
                      int lag, uint32_t index, int32_t *value) {
    int64_t sample = (int64_t)target->order + index + lag - reference->order;
    if (sample < 0 || sample >= reference->count) {
        *value = 0;
    } else {
        *value = reference->data[(uint32_t)sample];
    }
    return 1;
}

static int r4_fit(const R2_Subframe *reference, const R2_Subframe *target,
                  unsigned taps, const int lags[5], R4_Fit *fit) {
    memset(fit, 0, sizeof *fit);
    fit->taps = taps;
    for (unsigned j = 0; j < taps; ++j) fit->lags[j] = lags[j];
    if (!r4_eligible(reference) || !r4_eligible(target)) return 1;
    double gram[5][5] = {{0.0}};
    double vector[5] = {0.0};
    for (uint32_t i = 0; i < target->count; ++i) {
        double feature[5];
        double y = (double)target->data[i];
        for (unsigned j = 0; j < taps; ++j) {
            int32_t sample;
            r4_feature(reference, target, lags[j], i, &sample);
            feature[j] = (double)sample;
        }
        for (unsigned j = 0; j < taps; ++j) {
            vector[j] += feature[j] * y;
            for (unsigned k = j; k < taps; ++k)
                gram[j][k] += feature[j] * feature[k];
        }
    }
    double trace = 0.0;
    for (unsigned j = 0; j < taps; ++j) trace += gram[j][j];
    if (!isfinite(trace)) {
        fit->failure = 1;
        return 1;
    }
    if (trace == 0.0) {
        fit->degenerate = 1;
        return 1;
    }
    for (unsigned j = 0; j < taps; ++j)
        for (unsigned k = j + 1; k < taps; ++k)
            gram[k][j] = gram[j][k];
    double lower[5][5] = {{0.0}};
    double lambda = (trace / (double)taps) * 0x1p-16;
    for (unsigned i = 0; i < taps; ++i) {
        for (unsigned j = 0; j <= i; ++j) {
            double value = gram[i][j] + (i == j ? lambda : 0.0);
            for (unsigned k = 0; k < j; ++k)
                value -= lower[i][k] * lower[j][k];
            if (!isfinite(value) || (i == j && value <= 0.0)) {
                fit->failure = 1;
                return 1;
            }
            if (i == j) lower[i][j] = sqrt(value);
            else {
                if (lower[j][j] <= 0.0 || !isfinite(lower[j][j])) {
                    fit->failure = 1;
                    return 1;
                }
                lower[i][j] = value / lower[j][j];
            }
        }
    }
    double forward[5] = {0.0};
    double solution[5] = {0.0};
    for (unsigned i = 0; i < taps; ++i) {
        double value = vector[i];
        for (unsigned j = 0; j < i; ++j) value -= lower[i][j] * forward[j];
        if (!isfinite(value) || lower[i][i] <= 0.0) {
            fit->failure = 1;
            return 1;
        }
        forward[i] = value / lower[i][i];
    }
    for (unsigned reverse = taps; reverse > 0; --reverse) {
        unsigned i = reverse - 1;
        double value = forward[i];
        for (unsigned j = i + 1; j < taps; ++j) value -= lower[j][i] * solution[j];
        if (!isfinite(value) || lower[i][i] <= 0.0) {
            fit->failure = 1;
            return 1;
        }
        solution[i] = value / lower[i][i];
    }
    int any = 0;
    for (unsigned j = 0; j < taps; ++j) {
        double value = solution[j];
        if (!isfinite(value)) {
            fit->failure = 1;
            return 1;
        }
        if (value > 4.0) { value = 4.0; fit->q[j] = R4_COEFF_LIMIT; fit->clipped++; }
        else if (value < -4.0) { value = -4.0; fit->q[j] = -R4_COEFF_LIMIT; fit->clipped++; }
        else {
            double magnitude = floor(fabs(value) * (double)R4_Q12 + 0.5);
            int64_t quantized = (int64_t)magnitude;
            if (value < 0.0) quantized = -quantized;
            if (quantized > R4_COEFF_LIMIT) quantized = R4_COEFF_LIMIT;
            if (quantized < -R4_COEFF_LIMIT) quantized = -R4_COEFF_LIMIT;
            fit->q[j] = (int16_t)quantized;
        }
        if (fabs(solution[j]) > 4.0)
            fit->q[j] = solution[j] < 0.0 ? -R4_COEFF_LIMIT : R4_COEFF_LIMIT;
        if (fit->q[j] != 0) any = 1;
    }
    fit->valid = any;
    return 1;
}

static int r4_transform_subframe(R2_Subframe *target, const R2_Subframe *reference,
                                 const R4_Fit *fit, int inverse, R4_Counters *counters) {
    if (!fit->valid) return 1;
    for (uint32_t i = 0; i < target->count; ++i) {
        int64_t sum = 0;
        for (unsigned j = 0; j < fit->taps; ++j) {
            int32_t sample;
            r4_feature(reference, target, fit->lags[j], i, &sample);
            sum += (int64_t)fit->q[j] * sample;
        }
        int64_t prediction_wide = r4_floor_q12(sum);
        if (prediction_wide < INT32_MIN) {
            prediction_wide = INT32_MIN;
            if (counters) counters->prediction_clamp++;
        } else if (prediction_wide > INT32_MAX) {
            prediction_wide = INT32_MAX;
            if (counters) counters->prediction_clamp++;
        }
        int32_t prediction = (int32_t)prediction_wide;
        int32_t original;
        int64_t difference;
        if (inverse) {
            original = r3_u32_signed((uint32_t)target->data[i] + (uint32_t)prediction);
            difference = (int64_t)original - prediction;
            target->data[i] = original;
        } else {
            original = target->data[i];
            difference = (int64_t)original - prediction;
            target->data[i] = r3_u32_signed((uint32_t)original - (uint32_t)prediction);
        }
        if (difference < INT32_MIN || difference > INT32_MAX)
            if (counters) counters->modular_wrap++;
    }
    return 1;
}

static int r4_clone_frame(const R2_Frame *source, R2_Frame *copy) {
    *copy = *source;
    copy->sub[0].data = NULL;
    copy->sub[1].data = NULL;
    for (unsigned channel = 0; channel < 2; ++channel) {
        copy->sub[channel] = source->sub[channel];
        copy->sub[channel].data = calloc(source->sub[channel].count ? source->sub[channel].count : 1u,
                                         sizeof *copy->sub[channel].data);
        if (!copy->sub[channel].data) {
            r2_free_frame(copy);
            return 0;
        }
        if (source->sub[channel].count)
            memcpy(copy->sub[channel].data, source->sub[channel].data,
                   source->sub[channel].count * sizeof *copy->sub[channel].data);
    }
    return 1;
}

static int r4_rice_bytes_sub(const R2_Subframe *sub, uint64_t *bytes) {
    if (sub->type == FLAC__SUBFRAME_TYPE_CONSTANT || sub->type == FLAC__SUBFRAME_TYPE_VERBATIM) {
        *bytes = 0;
        return 1;
    }
    uint64_t bits = 0;
    for (uint32_t p = 0; p < sub->partition_count; ++p) {
        uint32_t start, count;
        if (!r2_partition_bounds(sub, p, &start, &count)) return 0;
        for (uint32_t i = 0; i < count; ++i) {
            uint32_t folded;
            if (!r2_fold(sub->data[start + i], &folded)) return 0;
            uint64_t add = (uint64_t)sub->parameters[p] + 1u + (folded >> sub->parameters[p]);
            if (UINT64_MAX - bits < add) return 0;
            bits += add;
        }
    }
    *bytes = (bits + 7u) / 8u;
    return 1;
}

static int r4_score_frame(R2_Frame *frame, uint64_t *score) {
    uint64_t left, right;
    if ((r4_predictive(&frame->sub[0]) && !r3_choose_k(&frame->sub[0])) ||
        (r4_predictive(&frame->sub[1]) && !r3_choose_k(&frame->sub[1])) ||
        !r4_rice_bytes_sub(&frame->sub[0], &left) || !r4_rice_bytes_sub(&frame->sub[1], &right) ||
        UINT64_MAX - left < right) return 0;
    *score = left + right;
    return 1;
}

static void r4_note_fit(const R4_Fit *fit, R4_Counters *counters) {
    if (!counters) return;
    if (fit->degenerate) counters->fit_degenerate++;
    if (fit->failure) counters->fit_failures++;
    counters->coefficient_clipping += fit->clipped;
}

static int r4_plan_frame(R2_Frame *frame, uint8_t profile, R4_Plan *plan,
                         R4_Counters *counters) {
    unsigned taps;
    int lags[5] = {0};
    if (!r4_profile(profile, &taps, lags)) return 0;
    memset(plan, 0, sizeof *plan);
    plan->taps = taps;
    uint64_t best_score = UINT64_MAX;
    R2_Frame best = {0};
    R2_Frame original = {0};
    if (!r4_clone_frame(frame, &original) || !r4_clone_frame(frame, &best) ||
        !r4_score_frame(&best, &best_score)) {
        r2_free_frame(&original);
        r2_free_frame(&best);
        return 0;
    }
    plan->selector = 0;
    if (taps == 0 || !r4_eligible(&frame->sub[0]) || !r4_eligible(&frame->sub[1])) {
        /* The disabled plan is already the complete choice for ineligible frames. */
    } else {
        for (unsigned direction = 0; direction < 2; ++direction) {
            R4_Fit fit;
            const R2_Subframe *reference = &frame->sub[direction];
            const R2_Subframe *target = &frame->sub[1u - direction];
            if (!r4_fit(reference, target, taps, lags, &fit)) {
                r2_free_frame(&original);
                r2_free_frame(&best);
                return 0;
            }
            r4_note_fit(&fit, counters);
            if (!fit.valid || fit.failure) continue;
            R2_Frame candidate = {0};
            if (!r4_clone_frame(frame, &candidate) ||
                !r4_transform_subframe(&candidate.sub[1u - direction], &candidate.sub[direction],
                                       &fit, 0, NULL)) {
                r2_free_frame(&candidate);
                r2_free_frame(&original);
                r2_free_frame(&best);
                return 0;
            }
            uint64_t score;
            if (!r4_score_frame(&candidate, &score)) {
                r2_free_frame(&candidate);
                r2_free_frame(&original);
                r2_free_frame(&best);
                return 0;
            }
            if (UINT64_MAX - score < (uint64_t)2u * taps) {
                r2_free_frame(&candidate); r2_free_frame(&original); r2_free_frame(&best); return 0;
            }
            score += (uint64_t)2u * taps;
            if (score < best_score) {
                r2_free_frame(&best);
                best = candidate;
                best_score = score;
                plan->selector = (uint8_t)(direction + 1u);
                memcpy(plan->q, fit.q, sizeof plan->q);
                plan->rice_bytes = score;
            } else {
                r2_free_frame(&candidate);
            }
        }
    }
    if (plan->selector == 0) plan->rice_bytes = best_score;
    if (plan->selector != 0) {
        R4_Fit selected = {.valid = 1, .taps = taps};
        memcpy(selected.q, plan->q, sizeof selected.q);
        memcpy(selected.lags, lags, sizeof selected.lags);
        unsigned direction = plan->selector - 1u;
        R4_Counters path = {0};
        if (!r4_transform_subframe(&original.sub[1u - direction], &original.sub[direction],
                                   &selected, 0, &path) ||
            memcmp(original.sub[0].data, best.sub[0].data,
                   best.sub[0].count * sizeof *best.sub[0].data) != 0 ||
            memcmp(original.sub[1].data, best.sub[1].data,
                   best.sub[1].count * sizeof *best.sub[1].data) != 0) {
            r2_free_frame(&original); r2_free_frame(&best); return 0;
        }
        if (counters) {
            counters->prediction_clamp += path.prediction_clamp;
            counters->modular_wrap += path.modular_wrap;
        }
    }
    r2_free_frame(&original);
    r2_free_frame(frame);
    *frame = best;
    if (plan->selector != 0) {
        if (counters) {
            if (plan->selector == 1) counters->reference0_frames++;
            else counters->reference1_frames++;
            counters->coefficient_bytes += (uint64_t)2u * taps;
        }
    } else if (counters) counters->disabled_frames++;
    return 1;
}

static int r4_audit_coded_frame(R2_Audit *audit, const R2_Frame *frame,
                                uint8_t selector, const int16_t q[5], unsigned taps) {
    if (!audit || !audit->file) return 1;
    if (!r2_audit_u16(audit, frame->blocksize) || !r2_audit_u8(audit, frame->assignment) ||
        !r2_audit_u8(audit, selector)) return 0;
    for (unsigned j = 0; j < taps; ++j)
        if (!r2_audit_u16(audit, (uint16_t)q[j])) return 0;
    for (unsigned channel = 0; channel < 2; ++channel) {
        const R2_Subframe *sub = &frame->sub[channel];
        if (!r2_audit_u8(audit, sub->type) || !r2_audit_u8(audit, sub->wasted) ||
            !r2_audit_u8(audit, sub->order) || !r2_audit_u8(audit, sub->precision) ||
            !r2_audit_u8(audit, (uint8_t)sub->shift) || !r2_audit_u8(audit, sub->method) ||
            !r2_audit_u8(audit, sub->partition_order) || !r2_audit_u8(audit, 0) ||
            !r2_audit_u32(audit, sub->count)) return 0;
        for (uint32_t i = 0; i < sub->order; ++i)
            if (!r2_audit_i32(audit, sub->warmup[i])) return 0;
        if (sub->type == FLAC__SUBFRAME_TYPE_LPC)
            for (uint32_t i = 0; i < sub->order; ++i)
                if (!r2_audit_i32(audit, sub->coefficients[i])) return 0;
        if (sub->type == FLAC__SUBFRAME_TYPE_FIXED || sub->type == FLAC__SUBFRAME_TYPE_LPC)
            for (uint32_t p = 0; p < sub->partition_count; ++p)
                if (!r2_audit_u8(audit, sub->parameters[p]) ||
                    !r2_audit_u8(audit, sub->raw_widths[p])) return 0;
        for (uint32_t i = 0; i < sub->count; ++i)
            if (!r2_audit_i32(audit, sub->data[i])) return 0;
    }
    return 1;
}

static int r4_write_header(FILE *output, uint8_t mode, uint8_t profile,
                           const R2_Rsd *input, const R2_Model *model) {
    if (!write_bytes(output, R4_MAGIC, 8) || !put_u8(output, mode) ||
        !put_u8(output, R4_SHAPE_PROFILE) || !put_u8(output, profile) ||
        !put_u8(output, 0) || !put_u64(output, input->manifest_length) ||
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

static int r4_read_header(FILE *input, uint8_t *mode, uint8_t *profile,
                          uint8_t **manifest, uint64_t *manifest_length,
                          uint64_t *record_count, R2_Model *model) {
    char magic[8];
    uint8_t shape, reserved;
    uint32_t table_count;
    if (!read_bytes(input, magic, sizeof magic) || memcmp(magic, R4_MAGIC, 8) != 0 ||
        !get_u8(input, mode) || !get_u8(input, &shape) || !get_u8(input, profile) ||
        !get_u8(input, &reserved) || !get_u64(input, manifest_length) ||
        !get_u64(input, record_count) || !get_u32(input, &table_count) ||
        shape != R4_SHAPE_PROFILE || reserved != 0 || *mode > 1 ||
        !r4_profile(*profile, &(unsigned){0}, (int[5]){0}) ||
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

static int r4_encode_frame(const R2_Frame *frame, const R4_Plan *plan,
                           R2_Model *model, uint8_t mode, FILE *output,
                           R2_Metrics *metrics) {
    R2_Bytes body = {0};
    uint8_t prefix[4] = {(uint8_t)frame->blocksize, (uint8_t)(frame->blocksize >> 8),
                         frame->assignment, plan->selector};
    if (!r2_bytes_write(&body, prefix, sizeof prefix)) goto fail;
    for (unsigned j = 0; j < (plan->selector ? plan->taps : 0); ++j) {
        uint16_t value = (uint16_t)plan->q[j];
        uint8_t bytes[2] = {(uint8_t)value, (uint8_t)(value >> 8)};
        if (!r2_bytes_write(&body, bytes, sizeof bytes)) goto fail;
    }
    if (!r2_encode_subframe(&frame->sub[0], model, mode, frame->assignment, 0, &body, metrics) ||
        !r2_encode_subframe(&frame->sub[1], model, mode, frame->assignment, 1, &body, metrics) ||
        body.length > R2_MAX_FRAME_BODY || body.length > UINT32_MAX) goto fail;
    uint8_t length[4] = {(uint8_t)body.length, (uint8_t)(body.length >> 8),
                         (uint8_t)(body.length >> 16), (uint8_t)(body.length >> 24)};
    if (!write_bytes(output, length, sizeof length) || !write_bytes(output, body.data, body.length)) goto fail;
    metrics->frame_count++;
    metrics->frame_bytes += body.length + 4;
    r2_bytes_free(&body);
    return 1;
fail:
    r2_bytes_free(&body);
    return 0;
}

static int r4_selector_counts(uint8_t selector, R4_Counters *counters, unsigned taps) {
    if (!counters) return 1;
    if (selector == 0) counters->disabled_frames++;
    else if (selector == 1) {
        counters->reference0_frames++;
        counters->coefficient_bytes += (uint64_t)2u * taps;
    } else if (selector == 2) {
        counters->reference1_frames++;
        counters->coefficient_bytes += (uint64_t)2u * taps;
    } else return 0;
    return 1;
}

static int r4_decode_frame(const uint8_t *body, size_t body_length, uint8_t mode,
                           uint8_t profile, R2_Model *model, FILE *output,
                           R3_Audit *original_audit, R2_Audit *coded_audit,
                           R2_Metrics *metrics, R4_Counters *counters) {
    R2_Cursor cursor = {.data = (uint8_t *)body, .length = body_length};
    uint16_t blocksize;
    uint8_t assignment, selector;
    if (!r2_cursor_u16(&cursor, &blocksize) || !r2_cursor_u8(&cursor, &assignment) ||
        !r2_cursor_u8(&cursor, &selector) || blocksize == 0 || assignment > 3 || selector > 2 ||
        (profile == 0 && selector != 0)) return 0;
    unsigned taps;
    int lags[5] = {0};
    if (!r4_profile(profile, &taps, lags)) return 0;
    R4_Fit fit = {.valid = selector != 0, .taps = taps};
    for (unsigned j = 0; j < (selector ? taps : 0); ++j) {
        uint16_t raw;
        if (!r2_cursor_u16(&cursor, &raw)) return 0;
        int32_t signed_raw = raw < UINT16_C(0x8000) ? (int32_t)raw :
                             (int32_t)raw - INT32_C(65536);
        if (signed_raw < -R4_COEFF_LIMIT || signed_raw > R4_COEFF_LIMIT) return 0;
        fit.q[j] = (int16_t)signed_raw;
    }
    if (selector != 0) {
        int any = 0;
        for (unsigned j = 0; j < taps; ++j) if (fit.q[j] != 0) any = 1;
        if (!any) return 0;
    }
    memcpy(fit.lags, lags, sizeof fit.lags);
    R2_Frame frame = {.blocksize = blocksize, .assignment = assignment};
    size_t position = cursor.position;
    for (unsigned channel = 0; channel < 2; ++channel) {
        size_t side_bytes;
        uint32_t entropy_bytes, bypass_bytes;
        if (!r2_decode_side_subframe(body, body_length, &position, blocksize, assignment,
                                     channel, mode, model, &frame.sub[channel], &side_bytes,
                                     &entropy_bytes, &bypass_bytes) ||
            !r3_validate_coded_subframe(&frame.sub[channel])) {
            r2_free_frame(&frame); return 0;
        }
        metrics->side_bytes += side_bytes;
        if (r4_predictive(&frame.sub[channel])) {
            metrics->predictive_subframes++;
            metrics->entropy_bytes += entropy_bytes;
            metrics->bypass_bytes += bypass_bytes;
        }
    }
    if (selector != 0 && (!r4_eligible(&frame.sub[0]) || !r4_eligible(&frame.sub[1]))) {
        r2_free_frame(&frame); return 0;
    }
    if (position != body_length || !r4_audit_coded_frame(coded_audit, &frame, selector, fit.q, selector ? taps : 0)) {
        r2_free_frame(&frame); return 0;
    }
    if (!r4_selector_counts(selector, counters, taps)) { r2_free_frame(&frame); return 0; }
    if (selector != 0) {
        unsigned direction = selector - 1u;
        if (!r4_transform_subframe(&frame.sub[1u - direction], &frame.sub[direction],
                                   &fit, 1, counters)) {
            r2_free_frame(&frame); return 0;
        }
    }
    if (!r3_audit_original_frame(original_audit, &frame)) { r2_free_frame(&frame); return 0; }
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
    free(values[0]); free(values[1]); r2_free_frame(&frame);
    return 1;
fail:
    free(values[0]); free(values[1]); r2_free_frame(&frame);
    return 0;
}

static int r4_counters_equal_path(const R4_Counters *a, const R4_Counters *b) {
    return a->prediction_clamp == b->prediction_clamp &&
           a->modular_wrap == b->modular_wrap;
}

static void r4_remove_path(const char *path) {
    if (strcmp(path, "-") != 0) remove(path);
}

static int r4_build_model(R2_Rsd *input, R2_Model *model, uint8_t profile) {
    memset(model, 0, sizeof *model);
    if (!r2_rewind_rsd(input)) return 0;
    uint64_t packed = 0, offset = 0;
    uint32_t chunk = 0;
    int has_previous = 0;
    for (uint64_t index = 0; index < input->record_count; ++index) {
        R2_Frame frame = {0};
        R4_Plan plan;
        if (!r2_read_rsd_frame(input->file, &frame) ||
            !r2_validate_sequence(&frame, index, &packed, &chunk, &offset, &has_previous) ||
            !r4_plan_frame(&frame, profile, &plan, NULL) ||
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

static int r4_write_summary(const char *path, uint8_t mode, uint8_t profile,
                            const R2_Model *model, const R2_Metrics *metrics,
                            const R4_Counters *counters, uint64_t file_bytes,
                            uint64_t original_audit_bytes, uint64_t manifest_bytes,
                            uint64_t input_records) {
    FILE *summary = fopen(path, "wb");
    if (!summary) return 0;
    int ok = fprintf(summary,
        "{\"format\":\"issue77-round4-summary-v1\",\"mode\":%u,"
        "\"predictorProfile\":%u,\"recordCount\":%" PRIu64 ","
        "\"frameCount\":%" PRIu64 ",\"predictiveSubframes\":%" PRIu64 ","
        "\"manifestBytes\":%" PRIu64 ",\"tableCount\":%u,\"tableBytes\":%" PRIu64 ","
        "\"sideBytes\":%" PRIu64 ",\"entropyBytes\":%" PRIu64 ","
        "\"bypassBytes\":%" PRIu64 ",\"frameBytes\":%" PRIu64 ","
        "\"fileBytes\":%" PRIu64 ",\"auditBytes\":%" PRIu64 ","
        "\"originalAuditBytes\":%" PRIu64 ",\"disabledFrames\":%" PRIu64 ","
        "\"reference0Frames\":%" PRIu64 ",\"reference1Frames\":%" PRIu64 ","
        "\"coefficientBytes\":%" PRIu64 ",\"predictionClamp\":%" PRIu64 ","
        "\"modularWrap\":%" PRIu64 ",\"fitDegenerate\":%" PRIu64 ","
        "\"fitFailures\":%" PRIu64 ",\"coefficientClipping\":%" PRIu64 ","
        "\"inputRecordCount\":%" PRIu64 "}\n",
        mode, profile, metrics->record_count, metrics->frame_count,
        metrics->predictive_subframes, manifest_bytes, model->table_count,
        (uint64_t)model->table_count * 37u, metrics->side_bytes,
        metrics->entropy_bytes, metrics->bypass_bytes, metrics->frame_bytes,
        file_bytes, metrics->audit_bytes, original_audit_bytes,
        counters->disabled_frames, counters->reference0_frames,
        counters->reference1_frames, counters->coefficient_bytes,
        counters->prediction_clamp, counters->modular_wrap,
        counters->fit_degenerate, counters->fit_failures,
        counters->coefficient_clipping, input_records);
    if (fclose(summary) != 0) ok = 0;
    return ok > 0;
}

static int r4_encode(const char *input_path, const char *output_path,
                     const char *original_audit_path, const char *coded_audit_path,
                     const char *summary_path, uint8_t mode, uint8_t profile) {
    R2_Rsd input;
    R2_Model model;
    FILE *output = NULL;
    R3_Audit original_audit = {0};
    R2_Audit coded_audit = {0};
    R2_Metrics metrics = {0};
    R4_Counters counters = {0};
    if (!r4_profile(profile, &(unsigned){0}, (int[5]){0}) ||
        !r2_open_rsd(input_path, &input)) {
        r2_fail("cannot open round4 RSD input");
        return 2;
    }
    if (mode == 1) {
        if (!r4_build_model(&input, &model, profile)) {
            r2_fail("cannot build round4 per-stem context model");
            r2_close_rsd(&input);
            return 2;
        }
    } else {
        memset(&model, 0, sizeof model);
        if (!r2_rewind_rsd(&input)) {
            r2_close_rsd(&input);
            return 2;
        }
    }
    output = fopen(output_path, "wb");
    if (!output || !r4_write_header(output, mode, profile, &input, &model) ||
        !r3_open_original_audit(original_audit_path, &original_audit) ||
        !r3_open_coded_audit(coded_audit_path, &coded_audit)) {
        r2_fail("cannot create round4 output");
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
        R2_Frame before = {0};
        R4_Plan plan;
        R4_Counters frame_counters = {0};
        int success = r2_read_rsd_frame(input.file, &frame) &&
                      r2_validate_sequence(&frame, index, &packed, &chunk, &offset, &has_previous) &&
                      r4_clone_frame(&frame, &before) &&
                      r4_plan_frame(&frame, profile, &plan, &frame_counters) &&
                      r4_encode_frame(&frame, &plan, &model, mode, output, &metrics) &&
                      r4_audit_coded_frame(&coded_audit, &frame, plan.selector, plan.q,
                                           plan.selector ? plan.taps : 0);
        if (!success) {
            r2_fail("RSD frame rejected during round4 encoding");
            r2_free_frame(&frame); r2_free_frame(&before);
            fclose(output);
            if (original_audit.file) fclose(original_audit.file);
            if (coded_audit.file) fclose(coded_audit.file);
            r2_close_rsd(&input);
            remove(output_path); r4_remove_path(original_audit_path);
            r4_remove_path(coded_audit_path); remove(summary_path);
            return 2;
        }
        R2_Frame restored = {0};
        R4_Counters inverse = {0};
        R4_Fit selected = {0};
        if (plan.selector != 0) {
            unsigned taps;
            int lags[5] = {0};
            if (!r4_profile(profile, &taps, lags)) {
                r2_free_frame(&frame); r2_free_frame(&before); r2_free_frame(&restored);
                fclose(output); if (original_audit.file) fclose(original_audit.file);
                if (coded_audit.file) fclose(coded_audit.file);
                r2_close_rsd(&input);
                remove(output_path); r4_remove_path(original_audit_path);
                r4_remove_path(coded_audit_path); remove(summary_path); return 2;
            }
            selected.valid = 1;
            selected.taps = taps;
            memcpy(selected.q, plan.q, sizeof selected.q);
            memcpy(selected.lags, lags, sizeof selected.lags);
        }
        if (!r4_clone_frame(&frame, &restored) ||
            (plan.selector != 0 &&
             !r4_transform_subframe(&restored.sub[1u - (plan.selector - 1u)],
                                    &restored.sub[plan.selector - 1u], &selected, 1,
                                    &inverse))) {
            r2_free_frame(&frame); r2_free_frame(&before); r2_free_frame(&restored);
            fclose(output); if (original_audit.file) fclose(original_audit.file);
            if (coded_audit.file) fclose(coded_audit.file);
            r2_close_rsd(&input);
            remove(output_path); r4_remove_path(original_audit_path);
            r4_remove_path(coded_audit_path); remove(summary_path); return 2;
        }
        int recovered = restored.sub[0].count == before.sub[0].count &&
                        restored.sub[1].count == before.sub[1].count &&
                        memcmp(restored.sub[0].data, before.sub[0].data,
                               before.sub[0].count * sizeof *before.sub[0].data) == 0 &&
                        memcmp(restored.sub[1].data, before.sub[1].data,
                               before.sub[1].count * sizeof *before.sub[1].data) == 0 &&
                        r4_counters_equal_path(&frame_counters, &inverse) &&
                        r3_audit_original_frame(&original_audit, &restored);
        if (!recovered) {
            r2_free_frame(&frame); r2_free_frame(&before); r2_free_frame(&restored);
            fclose(output); if (original_audit.file) fclose(original_audit.file);
            if (coded_audit.file) fclose(coded_audit.file);
            r2_close_rsd(&input);
            remove(output_path); r4_remove_path(original_audit_path);
            r4_remove_path(coded_audit_path); remove(summary_path); return 2;
        }
        counters.fit_degenerate += frame_counters.fit_degenerate;
        counters.fit_failures += frame_counters.fit_failures;
        counters.coefficient_clipping += frame_counters.coefficient_clipping;
        counters.prediction_clamp += frame_counters.prediction_clamp;
        counters.modular_wrap += frame_counters.modular_wrap;
        if (plan.selector == 0) counters.disabled_frames++;
        else if (plan.selector == 1) {
            counters.reference0_frames++;
            counters.coefficient_bytes += (uint64_t)2u * plan.taps;
        } else {
            counters.reference1_frames++;
            counters.coefficient_bytes += (uint64_t)2u * plan.taps;
        }
        r2_free_frame(&frame); r2_free_frame(&before); r2_free_frame(&restored);
        metrics.record_count++;
    }
    if (fgetc(input.file) != EOF || ferror(input.file) || fflush(output) != 0 ||
        (original_audit.file && fflush(original_audit.file) != 0) ||
        (coded_audit.file && fflush(coded_audit.file) != 0)) {
        r2_fail("RSD has trailing bytes or round4 output flush failed");
        fclose(output); if (original_audit.file) fclose(original_audit.file);
        if (coded_audit.file) fclose(coded_audit.file);
        r2_close_rsd(&input);
        remove(output_path); r4_remove_path(original_audit_path);
        r4_remove_path(coded_audit_path); remove(summary_path); return 2;
    }
    metrics.audit_bytes = coded_audit.bytes;
    off_t end = ftello(output);
    int ok = end >= 0 && fclose(output) == 0 &&
             (!original_audit.file || fclose(original_audit.file) == 0) &&
             (!coded_audit.file || fclose(coded_audit.file) == 0) &&
             r4_write_summary(summary_path, mode, profile, &model, &metrics, &counters,
                              (uint64_t)end, original_audit.bytes, input.manifest_length,
                              input.record_count);
    r2_close_rsd(&input);
    if (!ok) {
        remove(output_path); r4_remove_path(original_audit_path);
        r4_remove_path(coded_audit_path); remove(summary_path); return 2;
    }
    return 0;
}

static int r4_decode(const char *input_path, const char *output_path,
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
    R4_Counters counters = {0};
    if (!input || !r4_read_header(input, &mode, &profile, &manifest, &manifest_length,
                                  &record_count, &model)) {
        r2_fail("invalid round4 header or model table");
        if (input) fclose(input);
        free(manifest);
        return 2;
    }
    output = fopen(output_path, "wb");
    if (!output || !r3_open_original_audit(original_audit_path, &original_audit) ||
        !r3_open_coded_audit(coded_audit_path, &coded_audit)) {
        r2_fail("cannot create round4 decoded outputs");
        if (output) fclose(output);
        if (original_audit.file) fclose(original_audit.file);
        if (coded_audit.file) fclose(coded_audit.file);
        fclose(input); free(manifest); return 2;
    }
    for (uint64_t index = 0; index < record_count; ++index) {
        uint32_t body_bytes;
        if (!get_u32(input, &body_bytes) || body_bytes == 0 || body_bytes > R2_MAX_FRAME_BODY) {
            r2_fail("invalid round4 frame length"); goto fail;
        }
        uint8_t *body = malloc(body_bytes);
        if (!body || !read_bytes(input, body, body_bytes)) {
            free(body); r2_fail("truncated round4 frame"); goto fail;
        }
        int success = r4_decode_frame(body, body_bytes, mode, profile, &model, output,
                                      &original_audit, &coded_audit, &metrics, &counters);
        free(body);
        if (!success) { r2_fail("round4 frame failed validation"); goto fail; }
        metrics.record_count++;
    }
    if (fgetc(input) != EOF || ferror(input) || fflush(output) != 0 ||
        (original_audit.file && fflush(original_audit.file) != 0) ||
        (coded_audit.file && fflush(coded_audit.file) != 0)) {
        r2_fail("round4 trailing bytes or output flush failed"); goto fail;
    }
    metrics.audit_bytes = coded_audit.bytes;
    off_t output_bytes = ftello(output);
    off_t input_bytes = ftello(input);
    int ok = output_bytes >= 0 && input_bytes >= 0 && fclose(output) == 0 &&
             (!original_audit.file || fclose(original_audit.file) == 0) &&
             (!coded_audit.file || fclose(coded_audit.file) == 0) && fclose(input) == 0 &&
             r4_write_summary(summary_path, mode, profile, &model, &metrics, &counters,
                              (uint64_t)input_bytes, original_audit.bytes,
                              manifest_length, record_count);
    free(manifest);
    if (!ok) return 2;
    return 0;
fail:
    fclose(output); if (original_audit.file) fclose(original_audit.file);
    if (coded_audit.file) fclose(coded_audit.file);
    fclose(input); free(manifest);
    remove(output_path); r4_remove_path(original_audit_path);
    r4_remove_path(coded_audit_path); remove(summary_path); return 2;
}

#ifndef I77_ROUND4_NO_MAIN
static void r4_usage(const char *program) {
    fprintf(stderr,
            "usage:\n  %s encode INPUT_RSD OUTPUT ORIGINAL_AUDIT CODED_AUDIT SUMMARY MODE(0|1) PROFILE(0..2)\n"
            "  %s decode INPUT OUTPUT_RAW ORIGINAL_AUDIT CODED_AUDIT SUMMARY\n", program, program);
}

int main(int argc, char **argv) {
    if (argc == 9 && strcmp(argv[1], "encode") == 0) {
        char *end_mode = NULL, *end_profile = NULL;
        unsigned long mode = strtoul(argv[7], &end_mode, 10);
        unsigned long profile = strtoul(argv[8], &end_profile, 10);
        if (!end_mode || *end_mode != '\0' || mode > 1 || !end_profile ||
            *end_profile != '\0' || profile > R4_MAX_PROFILE) return 2;
        return r4_encode(argv[2], argv[3], argv[4], argv[5], argv[6],
                         (uint8_t)mode, (uint8_t)profile);
    }
    if (argc == 7 && strcmp(argv[1], "decode") == 0)
        return r4_decode(argv[2], argv[3], argv[4], argv[5], argv[6]);
    r4_usage(argv[0]);
    return 2;
}
#endif
