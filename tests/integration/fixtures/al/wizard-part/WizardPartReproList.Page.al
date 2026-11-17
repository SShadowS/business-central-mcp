page 50991 "MCP Wizard Part Repro List"
{
    PageType = ListPart;
    Caption = ' ', Locked = true;
    SourceTable = "Bank Account";
    InsertAllowed = false;
    DeleteAllowed = false;

    layout
    {
        area(Content)
        {
            repeater(BankAccountList)
            {
                field("No."; Rec."No.") { ApplicationArea = All; }
                field(Name; Rec.Name) { ApplicationArea = All; }
                field("Currency Code"; Rec."Currency Code") { ApplicationArea = All; Caption = 'Connection Details'; }
            }
        }
    }
}
