// macOS Dock 우클릭 메뉴 — "새 창"(Terminal.app·iTerm 관례). macOS 는 Dock 메뉴를 앱 델리게이트의
// applicationDockMenu: 로 가져간다(Apple 문서). NSApplication 에 setDockMenu API 가 없고 Tauri 도 Dock
// 메뉴 API 를 노출하지 않으므로(트레이·NSApp Window/Help 메뉴만), 이 델리게이트 메서드가 유일한 정공법.
//
// Tauri(tao)가 설치한 델리게이트 클래스에 applicationDockMenu: 와 액션(sokNewWindow:)을 런타임 추가한다
// — webview.rs hitTest 스위즐과 동일한 "기존 objc 클래스에 메서드 주입" 패턴. 앱 델리게이트는 하나뿐
// 이라 새 델리게이트로 교체하면 Tauri 생명주기 콜백(applicationDidFinishLaunching 등)이 끊긴다 → 교체가
// 오히려 파손. 그래서 교체가 아니라 미구현 셀렉터 추가(class_addMethod)로 확장한다.

use std::ffi::c_char;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::NSString;
use tauri::AppHandle;

// 액션이 새 창을 만들 때 쓰는 AppHandle(install 1회 설정). AppHandle 은 Send+Sync 라 static 가능.
static APP: OnceLock<AppHandle> = OnceLock::new();
// Dock 메뉴 포인터(앱 수명 leak 으로 생존). Retained<NSMenu> 는 !Sync 라 static 에 못 담으므로 usize 로
// 보관한다(webview.rs 가 NSView 포인터를 usize 로 다루는 것과 동일 결). 0 = 미설치.
static DOCK_MENU_PTR: AtomicUsize = AtomicUsize::new(0);

// applicationDockMenu:(id self, SEL _cmd, NSApplication* sender) -> NSMenu*. 인코딩 "@@:@".
type DockMenuFn =
    unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject;
// sokNewWindow:(id self, SEL _cmd, id sender) -> void. 인코딩 "v@:@".
type NewWindowFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

// Dock 우클릭 시 macOS 가 델리게이트에 보낸다 — 우리 메뉴 반환(미설치면 nil).
unsafe extern "C-unwind" fn dock_menu(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> *mut AnyObject {
    DOCK_MENU_PTR.load(Ordering::Relaxed) as *mut AnyObject
}

// "새 창" 항목 액션. Dock 메뉴 클릭은 메인 스레드라 create_window(WebviewWindowBuilder) 안전.
unsafe extern "C-unwind" fn new_window(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) {
    if let Some(app) = APP.get() {
        if let Err(e) = crate::window::create_window(app) {
            eprintln!("[dockmenu] 새 창 생성 실패: {e}");
        }
    }
}

// Dock 메뉴 설치(앱 전역 1회, lib.rs setup). 메인 스레드 필수.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[dockmenu] 메인 스레드 아님 — Dock 메뉴 미설치");
        return;
    };
    unsafe {
        let ns_app = NSApplication::sharedApplication(mtm);
        let delegate: *mut AnyObject = msg_send![&*ns_app, delegate];
        if delegate.is_null() {
            eprintln!("[dockmenu] NSApp 델리게이트 없음 — Dock 메뉴 미설치");
            return;
        }

        // 메뉴: "새 창" → sokNewWindow:(타겟 = 델리게이트, 앱 수명 생존). 메뉴는 leak 으로 앱 수명 유지
        // (Dock 가 우클릭 때마다 dock_menu 가 이 포인터를 반환).
        let menu = NSMenu::new(mtm);
        let item = NSMenuItem::new(mtm);
        item.setTitle(&NSString::from_str("새 창"));
        item.setTarget(Some(&*delegate));
        item.setAction(Some(sel!(sokNewWindow:)));
        menu.addItem(&item);
        DOCK_MENU_PTR.store(Retained::as_ptr(&menu) as usize, Ordering::Relaxed);
        std::mem::forget(menu);

        // 델리게이트 클래스에 두 셀렉터 주입. tao 델리게이트는 둘 다 미구현이라 class_addMethod 가
        // 추가한다(이미 있으면 false 반환·무변경 — 교체 아님). 인코딩은 위 fn 타입 주석 참조.
        let cls: &AnyClass = (*delegate).class();
        let cls_mut = (cls as *const AnyClass).cast_mut();
        let _ = objc2::ffi::class_addMethod(
            cls_mut,
            sel!(applicationDockMenu:),
            std::mem::transmute::<DockMenuFn, objc2::runtime::Imp>(dock_menu),
            c"@@:@".as_ptr() as *const c_char,
        );
        let _ = objc2::ffi::class_addMethod(
            cls_mut,
            sel!(sokNewWindow:),
            std::mem::transmute::<NewWindowFn, objc2::runtime::Imp>(new_window),
            c"v@:@".as_ptr() as *const c_char,
        );
        // 주입 검증(verify) — 없으면 Dock 메뉴가 안 뜬다.
        if cls.instance_method(sel!(applicationDockMenu:)).is_none()
            || cls.instance_method(sel!(sokNewWindow:)).is_none()
        {
            eprintln!("[dockmenu] 델리게이트 메서드 주입 실패 — Dock 메뉴 미작동");
        }
    }
}
