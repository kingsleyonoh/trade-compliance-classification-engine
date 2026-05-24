use super::UserScope;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResourceAction {
    ProductsRead,
    ProductsWrite,
    ClassificationsRead,
    ClassificationsRun,
    RulePacksManage,
    OverridesCreate,
    ExportsCreate,
    SettingsManage,
}

pub fn can_scope(scope: UserScope, action: ResourceAction) -> bool {
    match scope {
        UserScope::Admin => true,
        UserScope::Classifier => matches!(
            action,
            ResourceAction::ProductsRead
                | ResourceAction::ProductsWrite
                | ResourceAction::ClassificationsRead
                | ResourceAction::ClassificationsRun
                | ResourceAction::ExportsCreate
        ),
        UserScope::Reviewer => matches!(
            action,
            ResourceAction::ProductsRead
                | ResourceAction::ClassificationsRead
                | ResourceAction::OverridesCreate
                | ResourceAction::ExportsCreate
        ),
        UserScope::Auditor => matches!(
            action,
            ResourceAction::ProductsRead
                | ResourceAction::ClassificationsRead
                | ResourceAction::ExportsCreate
        ),
    }
}

pub fn can_admin_rule_packs_manage() -> bool {
    can_scope(UserScope::Admin, ResourceAction::RulePacksManage)
}
pub fn can_classifier_products_write() -> bool {
    can_scope(UserScope::Classifier, ResourceAction::ProductsWrite)
}
pub fn can_reviewer_overrides_create() -> bool {
    can_scope(UserScope::Reviewer, ResourceAction::OverridesCreate)
}
pub fn can_auditor_exports_create() -> bool {
    can_scope(UserScope::Auditor, ResourceAction::ExportsCreate)
}
