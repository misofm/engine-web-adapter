/*
 * Independent round-3 integer fixture driver.
 *
 * The production-shaped round3.c is included only so this small driver can
 * call its file-local Q20 FIR and Rice-search routines.  The Python test is
 * the independent bigint reference; this driver reports every native state
 * transition needed for comparison.
 */
#include "round3_integer_source.c"

#include <errno.h>

static int parse_i32(const char *text, int32_t *value) {
    char *end = NULL;
    errno = 0;
    long long parsed = strtoll(text, &end, 10);
    if (errno || !end || *end != '\0' || parsed < INT32_MIN || parsed > INT32_MAX) return 0;
    *value = (int32_t)parsed;
    return 1;
}

static int parse_unsigned(const char *text, unsigned *value) {
    char *end = NULL;
    errno = 0;
    unsigned long parsed = strtoul(text, &end, 10);
    if (errno || !end || *end != '\0' || parsed > UINT_MAX) return 0;
    *value = (unsigned)parsed;
    return 1;
}

static int parse_values(int argc, char **argv, int start, int32_t **values, size_t *count) {
    if (start > argc || (size_t)(argc - start) > 4096u) return 0;
    *count = (size_t)(argc - start);
    *values = calloc(*count ? *count : 1u, sizeof **values);
    if (!*values) return 0;
    for (size_t i = 0; i < *count; ++i) {
        if (!parse_i32(argv[start + (int)i], &(*values)[i])) {
            free(*values);
            *values = NULL;
            return 0;
        }
    }
    return 1;
}

static void print_u128_string(__uint128_t value) {
    char digits[64];
    size_t length = 0;
    do {
        digits[length++] = (char)('0' + (unsigned)(value % 10u));
        value /= 10u;
    } while (value != 0);
    putchar('"');
    while (length != 0) putchar(digits[--length]);
    putchar('"');
}

static void print_counters(const R3_Counters *counters) {
    printf("{\"predictionClamp\":%" PRIu64 ",\"coefficientClamp\":%" PRIu64
           ",\"modularWrap\":%" PRIu64 ",\"updates\":%" PRIu64 "}",
           counters->prediction_clamp, counters->coefficient_clamp,
           counters->modular_wrap, counters->updates);
}

static int run_trace(uint8_t profile, const int32_t *values, size_t count) {
    R3_State state;
    R3_Counters counters = {0};
    if (!r3_state_init(&state, profile)) return 0;
    printf("{\"kind\":\"trace\",\"profile\":%u,\"steps\":[", profile);
    for (size_t t = 0; t < count; ++t) {
        int32_t prediction;
        if (!r3_predict(&state, &prediction, &counters)) return 0;
        int32_t original = values[t];
        int64_t difference = (int64_t)original - prediction;
        int32_t encoded = r3_u32_signed((uint32_t)original - (uint32_t)prediction);
        int32_t recovered = r3_u32_signed((uint32_t)encoded + (uint32_t)prediction);
        if (difference < INT32_MIN || difference > INT32_MAX) counters.modular_wrap++;
        if (state.m && (t & 3u) == 3u) r3_update(&state, difference, &counters);
        if (state.m) {
            unsigned next_head = (state.head + state.m - 1u) % state.m;
            int64_t old = state.history[next_head];
            state.energy -= (__uint128_t)(old * old);
            state.head = next_head;
            state.history[state.head] = recovered;
            state.energy += (__uint128_t)((int64_t)recovered) * (__uint128_t)((int64_t)recovered);
        }
        if (t != 0) putchar(',');
        printf("{\"prediction\":%" PRId32 ",\"encoded\":%" PRId32
               ",\"recovered\":%" PRId32 ",\"difference\":%" PRId64
               ",\"head\":%u,\"energy\":", prediction, encoded, recovered,
               difference, state.head);
        print_u128_string(state.energy);
        printf(",\"coefficients\":[");
        for (unsigned j = 0; j < state.m; ++j) {
            if (j != 0) putchar(',');
            printf("%" PRId64, state.coefficient[j]);
        }
        printf("],\"history\":[");
        for (unsigned j = 0; j < state.m; ++j) {
            if (j != 0) putchar(',');
            printf("%" PRId32, state.history[(state.head + j) % state.m]);
        }
        printf("]}");
    }
    printf("],\"counters\":");
    print_counters(&counters);
    printf("}\n");
    return 1;
}

static int run_transform(uint8_t profile, const int32_t *values, size_t count) {
    if (count > UINT32_MAX) return 0;
    R2_Subframe sub = {0};
    sub.type = FLAC__SUBFRAME_TYPE_FIXED;
    sub.count = (uint32_t)count;
    /* Keep a nontrivial Rice partition description on longer vectors.  The
     * FIR must span these boundaries; partitioning belongs to entropy coding. */
    sub.partition_order = count >= 8u && count % 4u == 0u ? 2u : 0u;
    sub.partition_count = 1u << sub.partition_order;
    sub.data = calloc(count ? count : 1u, sizeof *sub.data);
    if (!sub.data) return 0;
    if (count) memcpy(sub.data, values, count * sizeof *sub.data);
    int32_t *encoded_copy = calloc(count ? count : 1u, sizeof *encoded_copy);
    if (!encoded_copy) {
        free(sub.data);
        return 0;
    }
    R3_Counters encoded_counters = {0}, decoded_counters = {0};
    int ok = r3_transform_subframe(&sub, profile, 0, &encoded_counters);
    if (ok && count) memcpy(encoded_copy, sub.data, count * sizeof *encoded_copy);
    printf("{\"kind\":\"transform\",\"profile\":%u,\"encoded\":[", profile);
    if (ok) for (size_t i = 0; i < count; ++i) {
        if (i != 0) putchar(',');
        printf("%" PRId32, sub.data[i]);
    }
    printf("],\"encodeCounters\":");
    print_counters(&encoded_counters);
    if (ok) ok = r3_transform_subframe(&sub, profile, 1, &decoded_counters);
    printf(",\"recovered\":[");
    if (ok) for (size_t i = 0; i < count; ++i) {
        if (i != 0) putchar(',');
        printf("%" PRId32, sub.data[i]);
    }
    printf("],\"decodeCounters\":");
    print_counters(&decoded_counters);
    /* A second fresh subframe must reproduce the first encoding.  This also
     * catches accidental state reuse across subframes in a single process. */
    R2_Subframe repeated = {0};
    R3_Counters repeated_counters = {0};
    repeated.type = FLAC__SUBFRAME_TYPE_FIXED;
    repeated.count = (uint32_t)count;
    repeated.partition_order = sub.partition_order;
    repeated.partition_count = sub.partition_count;
    repeated.data = calloc(count ? count : 1u, sizeof *repeated.data);
    if (!repeated.data) ok = 0;
    if (ok && count) memcpy(repeated.data, values, count * sizeof *repeated.data);
    if (ok && !r3_transform_subframe(&repeated, profile, 0, &repeated_counters)) ok = 0;
    if (ok && count && memcmp(repeated.data, encoded_copy, count * sizeof *encoded_copy) != 0) ok = 0;
    if (ok && !r3_counters_equal(&repeated_counters, &encoded_counters)) ok = 0;
    printf("}\n");
    free(repeated.data);
    free(encoded_copy);
    free(sub.data);
    return ok;
}

static int run_choose(unsigned order, unsigned partition_order,
                      const int32_t *values, size_t count) {
    if (order > MAX_LPC || count > UINT32_MAX || count + order > UINT16_MAX ||
        partition_order > MAX_PARTITION || ((count + order) % (1u << partition_order)) != 0) return 0;
    R2_Subframe sub = {0};
    sub.type = FLAC__SUBFRAME_TYPE_FIXED;
    sub.order = (uint8_t)order;
    sub.count = (uint32_t)count;
    sub.partition_order = (uint8_t)partition_order;
    sub.partition_count = 1u << partition_order;
    sub.data = calloc(count ? count : 1u, sizeof *sub.data);
    if (!sub.data) return 0;
    if (count) memcpy(sub.data, values, count * sizeof *sub.data);
    int ok = r3_choose_k(&sub);
    printf("{\"kind\":\"choose\",\"order\":%u,\"partitionOrder\":%u,\"parameters\":[",
           order, partition_order);
    if (ok) for (uint32_t p = 0; p < sub.partition_count; ++p) {
        if (p != 0) putchar(',');
        printf("%u", sub.parameters[p]);
    }
    printf("],\"method\":%u}\n", sub.method);
    free(sub.data);
    return ok;
}

static void integer_usage(const char *program) {
    fprintf(stderr, "usage: %s trace PROFILE VALUES...\n"
                    "       %s transform PROFILE VALUES...\n"
                    "       %s choose ORDER PARTITION_ORDER VALUES...\n", program, program, program);
}

int main(int argc, char **argv) {
    if (argc < 3) { integer_usage(argv[0]); return 2; }
    unsigned parsed_profile;
    int32_t *values = NULL;
    size_t count = 0;
    if ((strcmp(argv[1], "trace") == 0 || strcmp(argv[1], "transform") == 0) &&
        parse_unsigned(argv[2], &parsed_profile) && parsed_profile <= R3_MAX_PROFILE &&
        parse_values(argc, argv, 3, &values, &count)) {
        int ok = strcmp(argv[1], "trace") == 0
                     ? run_trace((uint8_t)parsed_profile, values, count)
                     : run_transform((uint8_t)parsed_profile, values, count);
        free(values);
        return ok ? 0 : 1;
    }
    if (strcmp(argv[1], "choose") == 0) {
        unsigned order, partition_order;
        if (argc >= 4 && parse_unsigned(argv[2], &order) && parse_unsigned(argv[3], &partition_order) &&
            parse_values(argc, argv, 4, &values, &count)) {
            int ok = run_choose(order, partition_order, values, count);
            free(values);
            return ok ? 0 : 1;
        }
    }
    integer_usage(argv[0]);
    return 2;
}
