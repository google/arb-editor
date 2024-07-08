# arb-editor

An extension to help you in editing .arb files, used for localization of applications.

### Features
 * JSON schema for `.arb` validation.
 * Snippets for `string`, `stringWithArgs`, `plural`, and `select` messages.
 * Full support of ICU MessageFormat syntax.
 * Diagnostics and Quick fixes.

### Sample `.arb` file
```
{
    "@@locale": "en",
    "@@x-template": "path/to/template.arb",
    "@@context": "HomePage",
    "helloAndWelcome": "Welcome {firstName} von {lastName}!",
    "@helloAndWelcome": {
        "description": "Initial welcome message",
        "placeholders": {
            "firstName": {
                "type": "String"
            },
            "lastName": {
                "type": "String"
            }
        }
    },
    "newMessages": "test {newMessages, plural, =0{No new messages} =1 {One new message} two{Two new Messages} other {test {newMessages} new messages}}",
    "@newMessages": {
        "type": "text",
        "description": "Number of new messages in inbox.",
        "placeholders": {
            "newMessages": {
                "type": "int"
            }
        }
    }
}
```

### Customize

Escaping quotes can be turned off by including a `l10n.yaml` file with the line:
```yaml
use-escaping: false
```

To set a template file, either set the `@@x-template` element in your `arb` file
```json
"@@x-template": "path/to/template.arb"
```
or set a file to be the template in the `l10n.yaml` using:
```yaml
template-arb-file: path/to/template.arb
```
You can suppress specific diagnostics warnings by adding into `settings.json`:
```json
"arbEditor.suppressedWarnings": string | string[]
```

The accepted values are:
- `"all"` - suppress all warnings
- An array containings the warinings ids to be suppressed:
```json
[
    "mismatched_brackets",
    "metadata_for_missing_key",
    "invalid_key",
    "missing_metadata_for_key",
    "invalid_placeholder",
    "missing_other_in_icu",
    "unknown_icu_message_type",
    "placeholder_without_metadata",
    "missing_placeholder_with_metadata",
    "missing_messages_from_template",
]
```