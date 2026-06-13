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

macro_rules! policy_symbol {
    ($name:ident, $scope:ident, $action:ident) => {
        pub fn $name() -> bool {
            can_scope(UserScope::$scope, ResourceAction::$action)
        }
    };
}

policy_symbol!(can_admin_products_read, Admin, ProductsRead);
policy_symbol!(can_admin_products_write, Admin, ProductsWrite);
policy_symbol!(can_admin_classifications_read, Admin, ClassificationsRead);
policy_symbol!(can_admin_classifications_run, Admin, ClassificationsRun);
policy_symbol!(can_admin_rule_packs_manage, Admin, RulePacksManage);
policy_symbol!(can_admin_overrides_create, Admin, OverridesCreate);
policy_symbol!(can_admin_exports_create, Admin, ExportsCreate);
policy_symbol!(can_admin_settings_manage, Admin, SettingsManage);

policy_symbol!(can_classifier_products_read, Classifier, ProductsRead);
policy_symbol!(can_classifier_products_write, Classifier, ProductsWrite);
policy_symbol!(
    can_classifier_classifications_read,
    Classifier,
    ClassificationsRead
);
policy_symbol!(
    can_classifier_classifications_run,
    Classifier,
    ClassificationsRun
);
policy_symbol!(
    can_classifier_rule_packs_manage,
    Classifier,
    RulePacksManage
);
policy_symbol!(can_classifier_overrides_create, Classifier, OverridesCreate);
policy_symbol!(can_classifier_exports_create, Classifier, ExportsCreate);
policy_symbol!(can_classifier_settings_manage, Classifier, SettingsManage);

policy_symbol!(can_reviewer_products_read, Reviewer, ProductsRead);
policy_symbol!(can_reviewer_products_write, Reviewer, ProductsWrite);
policy_symbol!(
    can_reviewer_classifications_read,
    Reviewer,
    ClassificationsRead
);
policy_symbol!(
    can_reviewer_classifications_run,
    Reviewer,
    ClassificationsRun
);
policy_symbol!(can_reviewer_rule_packs_manage, Reviewer, RulePacksManage);
policy_symbol!(can_reviewer_overrides_create, Reviewer, OverridesCreate);
policy_symbol!(can_reviewer_exports_create, Reviewer, ExportsCreate);
policy_symbol!(can_reviewer_settings_manage, Reviewer, SettingsManage);

policy_symbol!(can_auditor_products_read, Auditor, ProductsRead);
policy_symbol!(can_auditor_products_write, Auditor, ProductsWrite);
policy_symbol!(
    can_auditor_classifications_read,
    Auditor,
    ClassificationsRead
);
policy_symbol!(can_auditor_classifications_run, Auditor, ClassificationsRun);
policy_symbol!(can_auditor_rule_packs_manage, Auditor, RulePacksManage);
policy_symbol!(can_auditor_overrides_create, Auditor, OverridesCreate);
policy_symbol!(can_auditor_exports_create, Auditor, ExportsCreate);
policy_symbol!(can_auditor_settings_manage, Auditor, SettingsManage);
