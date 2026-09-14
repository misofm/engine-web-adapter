#![no_std]

use blake3::Hasher;
use core::mem::MaybeUninit;

const INPUT_CAPACITY: usize = 16 * 1024;
const OUTPUT_BYTES: usize = 32;

#[repr(align(64))]
struct Aligned<T>(T);

static mut HASHER: Aligned<MaybeUninit<Hasher>> = Aligned(MaybeUninit::uninit());
static mut INITIALIZED: bool = false;
static mut INPUT: Aligned<[u8; INPUT_CAPACITY]> = Aligned([0; INPUT_CAPACITY]);
static mut OUTPUT: Aligned<[u8; OUTPUT_BYTES]> = Aligned([0; OUTPUT_BYTES]);

#[unsafe(no_mangle)]
pub extern "C" fn blake3_input_ptr() -> usize {
    unsafe { core::ptr::addr_of_mut!(INPUT.0) as usize }
}

#[unsafe(no_mangle)]
pub extern "C" fn blake3_input_capacity() -> usize {
    INPUT_CAPACITY
}

#[unsafe(no_mangle)]
pub extern "C" fn blake3_output_ptr() -> usize {
    unsafe { core::ptr::addr_of_mut!(OUTPUT.0) as usize }
}

#[unsafe(no_mangle)]
pub extern "C" fn blake3_output_len() -> usize {
    OUTPUT_BYTES
}

#[unsafe(no_mangle)]
pub extern "C" fn blake3_init() {
    // This is the sole owner of the module-local Hasher. The instance is
    // created before any reference is taken, and every operation borrows it
    // for the duration of the call only.
    unsafe {
        if INITIALIZED {
            core::ptr::drop_in_place(core::ptr::addr_of_mut!(HASHER.0).cast::<Hasher>());
        }
        core::ptr::addr_of_mut!(HASHER.0).cast::<Hasher>().write(Hasher::new());
        INITIALIZED = true;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn blake3_update(length: usize) -> i32 {
    if length > INPUT_CAPACITY {
        return -1;
    }
    unsafe {
        if !INITIALIZED {
            return -2;
        }
        let hasher = &mut *core::ptr::addr_of_mut!(HASHER.0).cast::<Hasher>();
        let input = core::slice::from_raw_parts(
            core::ptr::addr_of!(INPUT.0) as *const u8,
            length,
        );
        hasher.update(input);
    }
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn blake3_finalize() -> i32 {
    unsafe {
        if !INITIALIZED {
            return -2;
        }
        let hasher = &*core::ptr::addr_of!(HASHER.0).cast::<Hasher>();
        core::ptr::copy_nonoverlapping(
            hasher.finalize().as_bytes().as_ptr(),
            core::ptr::addr_of_mut!(OUTPUT.0) as *mut u8,
            OUTPUT_BYTES,
        );
    }
    0
}

#[panic_handler]
fn panic(_panic: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}
