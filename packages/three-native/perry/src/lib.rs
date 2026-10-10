//! Perry strings and rooted callback trampolines; all engine memory belongs to the C shim.
use std::ffi::CStr;
use std::sync::{Mutex, Once};
use perry_ffi::{alloc_string, read_string, gc_register_mutable_root_scanner_named, GcRootVisitor,
    JsString, JsClosure, RawClosureHeader, StringHeader};

static CALLBACKS: Mutex<Option<Box<[f64; 2]>>> = Mutex::new(None);
fn scan(visitor: &mut GcRootVisitor<'_>) {
    let mut guard = CALLBACKS.lock().unwrap();
    if let Some(values) = guard.as_mut() {
        for value in values.iter_mut() { visitor.visit_nanbox_f64_slot(value); }
    }
}
#[no_mangle]
pub extern "C" fn js_tnp_bind(invoke: f64, release: f64) -> i32 {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| gc_register_mutable_root_scanner_named("tn-native-transport", scan));
    let mut guard = CALLBACKS.lock().unwrap();
    if guard.is_some() { return 8; }
    *guard = Some(Box::new([invoke, release]));
    0
}
fn closure(index: usize) -> Option<JsClosure> {
    let guard = CALLBACKS.lock().unwrap();
    let value = guard.as_ref()?[index];
    if value.to_bits() == 0 { return None; }
    Some(unsafe { JsClosure::from_raw((value.to_bits() & 0x0000_FFFF_FFFF_FFFF) as *const RawClosureHeader) })
}
#[no_mangle]
pub unsafe extern "C" fn tnp_dispatch(id: usize, args: usize, count: u32, packet: usize) -> u32 {
    match closure(0) {
        Some(call) => call.call4(id as f64, args as f64, count as f64, packet as f64) as u32,
        None => 8,
    }
}
#[no_mangle]
pub unsafe extern "C" fn tnp_release_callback(id: usize) {
    if let Some(call) = closure(1) { call.call1(id as f64); }
}
#[no_mangle]
pub unsafe extern "C" fn js_tnp_read_string(pointer: i64, count: i64) -> *mut StringHeader {
    if pointer == 0 { return alloc_string("").as_raw(); }
    let bytes = if count < 0 { CStr::from_ptr(pointer as *const i8).to_bytes() }
        else { std::slice::from_raw_parts(pointer as *const u8, count as usize) };
    alloc_string(&String::from_utf8_lossy(bytes)).as_raw()
}
#[no_mangle]
pub extern "C" fn js_tnp_string_bytes(text: JsString) -> i64 {
    read_string(text).map_or(-1, |value| value.len() as i64)
}
#[no_mangle]
pub unsafe extern "C" fn js_tnp_write_string(text: JsString, pointer: i64, capacity: i64) -> i32 {
    let Some(text) = read_string(text) else { return 1; };
    if pointer == 0 || capacity <= 0 { return 1; }
    let mut count = text.len().min(capacity as usize - 1);
    while !text.is_char_boundary(count) { count -= 1; }
    std::ptr::copy_nonoverlapping(text.as_ptr(), pointer as *mut u8, count);
    *((pointer as *mut u8).add(count)) = 0;
    0
}

static PLAYER_CALLBACKS: Mutex<Option<Box<[f64; 3]>>> = Mutex::new(None);
fn scan_player(visitor: &mut GcRootVisitor<'_>) {
    let mut guard = PLAYER_CALLBACKS.lock().unwrap();
    if let Some(values) = guard.as_mut() {
        for value in values.iter_mut() { visitor.visit_nanbox_f64_slot(value); }
    }
}
#[no_mangle]
pub extern "C" fn js_tnp_player_bind(update: f64, frame: f64, observe: f64) -> i32 {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| gc_register_mutable_root_scanner_named("tn-perry-player", scan_player));
    let mut guard = PLAYER_CALLBACKS.lock().unwrap();
    if guard.is_some() { return 8; }
    *guard = Some(Box::new([update, frame, observe]));
    0
}
fn player_closure(index: usize) -> Option<JsClosure> {
    let guard = PLAYER_CALLBACKS.lock().unwrap();
    let value = guard.as_ref()?[index];
    Some(unsafe { JsClosure::from_raw((value.to_bits() & 0x0000_FFFF_FFFF_FFFF) as *const RawClosureHeader) })
}
#[no_mangle]
pub unsafe extern "C" fn tnp_player_update(dt: f64) {
    if let Some(call) = player_closure(0) { call.call1(dt); }
}
#[no_mangle]
pub unsafe extern "C" fn tnp_player_frame(ms: f64) {
    if let Some(call) = player_closure(1) { call.call1(ms); }
}
#[no_mangle]
pub unsafe extern "C" fn tnp_player_observe(method: f64, argument: f64) -> f64 {
    player_closure(2).map_or(0.0, |call| call.call2(method, argument))
}
