// Repro for a NavigatePage whose step 2 hosts a ListPart without SubPageLink and with a
// blank caption (shape of Continia "CTS-CB MultiBankAccAssistSetup" / "CTS-CB SetupMultiBankAccList").
page 50990 "MCP Wizard Part Repro"
{
    PageType = NavigatePage;
    SourceTable = "Bank Account";
    Caption = 'MCP Wizard Part Repro';

    layout
    {
        area(Content)
        {
            group(Step1)
            {
                ShowCaption = false;
                Visible = Step = 1;
                label(Step1Txt) { ApplicationArea = All; Caption = 'Step 1: select Next to see the bank accounts.'; }
            }
            group(Step2)
            {
                ShowCaption = false;
                Visible = Step = 2;
                group(Step2TxtGrp)
                {
                    Caption = 'Bank Accounts';
                    label(Step2Txt) { ApplicationArea = All; Caption = 'Step 2: select a bank account and select Next.'; }
                }
                part(SetupBankAccountList; "MCP Wizard Part Repro List") { ApplicationArea = All; }
                field(BankAccountErrors; BankAccountErrors) { ApplicationArea = All; Editable = false; MultiLine = true; ShowCaption = false; }
            }
            group(Step3)
            {
                ShowCaption = false;
                Visible = Step = 3;
                field(SelectedNo; SelectedNo) { ApplicationArea = All; Caption = 'Selected Bank Account'; Editable = false; }
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action(Back)
            {
                ApplicationArea = All;
                Caption = 'Back';
                InFooterBar = true;
                Enabled = Step > 1;
                Image = PreviousRecord;
                trigger OnAction()
                begin
                    Step -= 1;
                end;
            }
            action(Next)
            {
                ApplicationArea = All;
                Caption = 'Next';
                InFooterBar = true;
                Enabled = Step < 3;
                Image = NextRecord;
                trigger OnAction()
                var
                    BankAccount: Record "Bank Account";
                begin
                    if Step = 2 then begin
                        CurrPage.SetupBankAccountList.Page.GetRecord(BankAccount);
                        SelectedNo := BankAccount."No.";
                    end;
                    Step += 1;
                end;
            }
            action(Finish)
            {
                ApplicationArea = All;
                Caption = 'Finish';
                InFooterBar = true;
                Enabled = Step = 3;
                Image = Approve;
                trigger OnAction()
                begin
                    CurrPage.Close();
                end;
            }
        }
    }

    trigger OnOpenPage()
    begin
        Step := 1;
    end;

    var
        Step: Integer;
        BankAccountErrors: Text;
        SelectedNo: Code[20];
}
