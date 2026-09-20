/* Independent integer-stage driver for the round-5 native fixtures. */
#define I77_ROUND5_NO_MAIN
#include "round5.c"
#undef I77_ROUND5_NO_MAIN

static int driver_read_values(int32_t *values, uint32_t count) {
    for (uint32_t i = 0; i < count; ++i) {
        long long value;
        if (scanf("%lld", &value) != 1 || value < INT32_MIN || value > INT32_MAX) return 0;
        values[i] = (int32_t)value;
    }
    return 1;
}

static void driver_print_values(const char *label, const int32_t *values, uint32_t count) {
    printf("%s", label);
    for (uint32_t i = 0; i < count; ++i) printf(" %" PRId32, values[i]);
    putchar('\n');
}

static int driver_parse_i32(const char *text, int32_t *value) {
    char *end = NULL;
    long long parsed = strtoll(text, &end, 10);
    if (!end || *end != '\0' || parsed < INT32_MIN || parsed > INT32_MAX) return 0;
    *value = (int32_t)parsed;
    return 1;
}

static int driver_fir(uint32_t count) {
    int32_t *values = calloc(count ? count : 1u, sizeof *values);
    int32_t *encoded = calloc(count ? count : 1u, sizeof *encoded);
    int32_t *original = calloc(count ? count : 1u, sizeof *original);
    if (!values || !encoded || !original || !driver_read_values(values, count)) {
        free(values); free(encoded); free(original); return 2;
    }
    memcpy(original, values, count * sizeof *original);
    R2_Subframe source = {.type = FLAC__SUBFRAME_TYPE_FIXED, .count = count, .data = values};
    R3_Counters forward = {0}, inverse = {0};
    if (!r3_transform_subframe(&source, R5_FIR_PROFILE, 0, &forward)) {
        free(values); free(encoded); free(original); return 2;
    }
    memcpy(encoded, values, count * sizeof *encoded);
    R2_Subframe recovered = {.type = FLAC__SUBFRAME_TYPE_FIXED, .count = count, .data = encoded};
    if (!r3_transform_subframe(&recovered, R5_FIR_PROFILE, 1, &inverse)) {
        free(values); free(encoded); free(original); return 2;
    }
    driver_print_values("forward", values, count);
    driver_print_values("recovered", encoded, count);
    printf("counters %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
           forward.prediction_clamp, forward.coefficient_clamp,
           forward.modular_wrap, forward.updates);
    printf("inverse_counters %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
           inverse.prediction_clamp, inverse.coefficient_clamp,
           inverse.modular_wrap, inverse.updates);
    int ok = memcmp(original, encoded, count * sizeof *values) == 0;
    free(values); free(encoded); free(original);
    return ok ? 0 : 1;
}

static int driver_pipeline(uint8_t selector, uint32_t count, uint8_t left_type,
                           uint8_t right_type, uint8_t left_order, uint8_t right_order,
                           const int16_t q[5]) {
    uint32_t blocksize = count + (left_order > right_order ? left_order : right_order);
    if (blocksize == 0 || blocksize > UINT16_MAX || left_order > MAX_LPC ||
        right_order > MAX_LPC || left_order > blocksize || right_order > blocksize)
        return 2;
    R2_Frame original = {.blocksize = (uint16_t)blocksize,
                         .assignment = FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT};
    R2_Frame coded = original;
    original.sub[0].type = left_type;
    original.sub[1].type = right_type;
    original.sub[0].order = left_order;
    original.sub[1].order = right_order;
    original.sub[0].count = original.sub[1].count = count;
    coded.sub[0] = original.sub[0];
    coded.sub[1] = original.sub[1];
    original.sub[0].data = calloc(count ? count : 1u, sizeof(int32_t));
    original.sub[1].data = calloc(count ? count : 1u, sizeof(int32_t));
    coded.sub[0].data = calloc(count ? count : 1u, sizeof(int32_t));
    coded.sub[1].data = calloc(count ? count : 1u, sizeof(int32_t));
    if (!original.sub[0].data || !original.sub[1].data || !coded.sub[0].data ||
        !coded.sub[1].data || !driver_read_values(original.sub[0].data, count) ||
        !driver_read_values(original.sub[1].data, count)) {
        r2_free_frame(&original); r2_free_frame(&coded); return 2;
    }
    memcpy(coded.sub[0].data, original.sub[0].data, count * sizeof(int32_t));
    memcpy(coded.sub[1].data, original.sub[1].data, count * sizeof(int32_t));
    R5_Plan plan = {.selected_selector = selector};
    memcpy(plan.q, q, sizeof plan.q);
    R3_Counters forward_fir = {0};
    R4_Counters forward_spatial = {0};
    if ((selector & 3u) != 0 &&
        !r5_apply_spatial(&coded, selector, plan.q, 0, &forward_spatial)) goto fail;
    if ((selector & 4u) != 0 &&
        (!r3_transform_subframe(&coded.sub[0], R5_FIR_PROFILE, 0, &forward_fir) ||
         !r3_transform_subframe(&coded.sub[1], R5_FIR_PROFILE, 0, &forward_fir))) goto fail;
    driver_print_values("coded_left", coded.sub[0].data, count);
    driver_print_values("coded_right", coded.sub[1].data, count);
    R3_Counters inverse_fir = {0};
    R4_Counters inverse_spatial = {0};
    if (!r5_inverse_frame(&coded, &plan, &inverse_fir, &inverse_spatial) ||
        memcmp(coded.sub[0].data, original.sub[0].data, count * sizeof(int32_t)) != 0 ||
        memcmp(coded.sub[1].data, original.sub[1].data, count * sizeof(int32_t)) != 0) goto fail;
    printf("selector %u 1 %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64
           " %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
           selector, forward_fir.updates, inverse_fir.updates,
           forward_spatial.prediction_clamp, forward_spatial.modular_wrap,
           inverse_spatial.prediction_clamp, inverse_spatial.modular_wrap,
           forward_fir.modular_wrap, inverse_fir.modular_wrap);
    r2_free_frame(&original); r2_free_frame(&coded);
    return 0;
fail:
    r2_free_frame(&original); r2_free_frame(&coded);
    return 1;
}

static int driver_threshold(uint8_t policy, uint64_t cheap_bytes,
                            uint64_t temporal_bytes, uint64_t stacked_bytes) {
    R5_Candidate cheap = {.valid = 1, .selector = 0, .rice_bytes = cheap_bytes};
    R5_Candidate temporal = {.valid = 1, .selector = 4, .rice_bytes = temporal_bytes};
    R5_Candidate stacked = {.valid = 1, .selector = 5, .rice_bytes = stacked_bytes};
    R5_Candidate *chosen = r5_choose_candidate(&cheap, &temporal, &stacked, policy);
    printf("selected %u\n", chosen->selector);
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "fir") == 0) {
        char *end = NULL;
        unsigned long count = strtoul(argv[2], &end, 10);
        if (!end || *end != '\0' || count > UINT16_MAX) return 2;
        return driver_fir((uint32_t)count);
    }
    if (argc == 4 && strcmp(argv[1], "selector") == 0) {
        char *end_selector = NULL, *end_count = NULL;
        unsigned long selector = strtoul(argv[2], &end_selector, 10);
        unsigned long count = strtoul(argv[3], &end_count, 10);
        if (!end_selector || *end_selector != '\0' || !end_count || *end_count != '\0' ||
            selector > 6 || count == 0 || count > UINT16_MAX || !r5_selector_valid((uint8_t)selector)) return 2;
        const int16_t q[5] = {0, 0, 8192, 0, 0};
        return driver_pipeline((uint8_t)selector, (uint32_t)count,
                               FLAC__SUBFRAME_TYPE_FIXED, FLAC__SUBFRAME_TYPE_FIXED,
                               0, 0, q);
    }
    if (argc == 13 && strcmp(argv[1], "pipeline") == 0) {
        char *end_selector = NULL, *end_count = NULL, *end_left_order = NULL;
        char *end_right_order = NULL, *end_left_type = NULL, *end_right_type = NULL;
        unsigned long selector = strtoul(argv[2], &end_selector, 10);
        unsigned long count = strtoul(argv[3], &end_count, 10);
        unsigned long left_order = strtoul(argv[4], &end_left_order, 10);
        unsigned long right_order = strtoul(argv[5], &end_right_order, 10);
        unsigned long left_type = strtoul(argv[6], &end_left_type, 10);
        unsigned long right_type = strtoul(argv[7], &end_right_type, 10);
        int16_t q[5];
        if (!end_selector || *end_selector != '\0' || !end_count || *end_count != '\0' ||
            !end_left_order || *end_left_order != '\0' || !end_right_order || *end_right_order != '\0' ||
            !end_left_type || *end_left_type != '\0' || !end_right_type || *end_right_type != '\0' ||
            selector > 6 || count == 0 || count > UINT16_MAX || !r5_selector_valid((uint8_t)selector) ||
            left_type > FLAC__SUBFRAME_TYPE_LPC || right_type > FLAC__SUBFRAME_TYPE_LPC ||
            (left_type != FLAC__SUBFRAME_TYPE_FIXED && left_type != FLAC__SUBFRAME_TYPE_LPC) ||
            (right_type != FLAC__SUBFRAME_TYPE_FIXED && right_type != FLAC__SUBFRAME_TYPE_LPC) ||
            left_order > MAX_LPC || right_order > MAX_LPC) return 2;
        for (unsigned j = 0; j < R5_SPATIAL_TAPS; ++j) {
            int32_t value;
            if (!driver_parse_i32(argv[8 + j], &value) || value < -R4_COEFF_LIMIT ||
                value > R4_COEFF_LIMIT) return 2;
            q[j] = (int16_t)value;
        }
        return driver_pipeline((uint8_t)selector, (uint32_t)count,
                               (uint8_t)left_type, (uint8_t)right_type,
                               (uint8_t)left_order, (uint8_t)right_order, q);
    }
    if (argc == 6 && strcmp(argv[1], "threshold") == 0) {
        char *end_policy = NULL, *end_cheap = NULL, *end_temporal = NULL, *end_stacked = NULL;
        unsigned long policy = strtoul(argv[2], &end_policy, 10);
        unsigned long long cheap = strtoull(argv[3], &end_cheap, 10);
        unsigned long long temporal = strtoull(argv[4], &end_temporal, 10);
        unsigned long long stacked = strtoull(argv[5], &end_stacked, 10);
        if (!end_policy || *end_policy != '\0' || policy > R5_MAX_POLICY ||
            !end_cheap || *end_cheap != '\0' || !end_temporal || *end_temporal != '\0' ||
            !end_stacked || *end_stacked != '\0') return 2;
        return driver_threshold((uint8_t)policy, (uint64_t)cheap,
                                (uint64_t)temporal, (uint64_t)stacked);
    }
    fprintf(stderr, "usage: %s fir COUNT | selector SELECTOR COUNT | "
                    "pipeline SELECTOR COUNT ORDER_L ORDER_R TYPE_L TYPE_R Q0 Q1 Q2 Q3 Q4\n",
            argv[0]);
    return 2;
}
